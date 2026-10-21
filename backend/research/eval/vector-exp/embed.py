"""向量对比实验：本地 embedding（129号阶段2，本机一次性实验，不进线上）。

上次在后台跑时，系统内存吃紧被回收。这一版按"省内存、可续跑"写：
  - 一次只跑一个模型；torch 限 2 线程；batch 8；
  - 每 256 块存一个分片（shard_XXXX.npy），中断后重跑只补缺失分片；
  - 每个分片开始前检查系统可用内存，低于阈值就等（每 60 秒查一次），不抢资源。

用法：python -I embed.py <数据目录> <bge|e5> [最低可用内存GB，默认 2.5]
"""
import ctypes
import json
import os
import sys
import time

import numpy as np

# 日志里有中文：pythonw 或 Windows 控制台默认 GBK，统一按 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

MODELS = {
    # (HF 模型名, 查询前缀, 文档前缀)
    'bge': ('BAAI/bge-small-en-v1.5', 'Represent this sentence for searching relevant passages: ', ''),
    'e5': ('intfloat/multilingual-e5-small', 'query: ', 'passage: '),
}
SHARD = 256


def free_gb():
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                    ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                    ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                    ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                    ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
    s = MEMORYSTATUSEX()
    s.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
    return s.ullAvailPhys / 2**30


def wait_for_memory(min_gb, label, max_wait_s):
    """可用内存 >= min_gb 才继续；最多等 max_wait_s 秒，之后照跑（常驻程序不释放内存时不能永远卡住）。"""
    waited = 0
    while True:
        f = free_gb()
        if f >= min_gb:
            return
        if waited >= max_wait_s:
            print(f'[{time.strftime("%H:%M:%S")}] {label}: 已等 {waited // 60} 分钟，可用 {f:.1f}GB，继续执行', flush=True)
            return
        if waited == 0:
            print(f'[{time.strftime("%H:%M:%S")}] {label}: 可用内存 {f:.1f}GB < {min_gb}GB，等待', flush=True)
        time.sleep(60)
        waited += 60


# 两道门：
#   启动门：加载模型前要求可用 >= min_gb（默认 2.5GB），最多等 60 分钟；
#   分片门：本进程常驻约 0.6GB、每片增量很小，只在可用 < 1.2GB（全机接近吃紧）时暂停，最多等 10 分钟。
#   2026-10-21 实测：本机常驻 Chrome/微信等使可用内存长期在 2.1–2.8GB，若每片都按 2.5GB 卡，31 片要等一整天。
SHARD_FLOOR_GB = 1.2


def main():
    d, name = sys.argv[1], sys.argv[2]
    min_gb = float(sys.argv[3]) if len(sys.argv) > 3 else 2.5
    mid, qp, dp = MODELS[name]
    out = os.path.join(d, name)
    os.makedirs(out, exist_ok=True)

    import torch
    torch.set_num_threads(2)
    from sentence_transformers import SentenceTransformer

    chunks = [json.loads(l) for l in open(os.path.join(d, 'chunks.jsonl'), encoding='utf8')]
    qs = json.load(open(os.path.join(d, 'queries.json'), encoding='utf8'))
    n_shards = (len(chunks) + SHARD - 1) // SHARD
    todo = [i for i in range(n_shards) if not os.path.exists(os.path.join(out, f'shard_{i:04d}.npy'))]
    print(f'{name}: {len(chunks)} chunks, {n_shards} shards, {len(todo)} to do, free {free_gb():.1f}GB', flush=True)

    wait_for_memory(min_gb, 'load model', 3600)
    model = SentenceTransformer(mid, device='cpu')
    model.max_seq_length = 512
    t0 = time.time()
    for k, i in enumerate(todo):
        wait_for_memory(SHARD_FLOOR_GB, f'shard {i}', 600)
        texts = [dp + c['text'] for c in chunks[i * SHARD:(i + 1) * SHARD]]
        e = model.encode(texts, batch_size=8, normalize_embeddings=True, show_progress_bar=False)
        tmp = os.path.join(out, f'shard_{i:04d}.tmp.npy')
        np.save(tmp, e.astype(np.float32))
        os.replace(tmp, os.path.join(out, f'shard_{i:04d}.npy'))
        if k % 5 == 0 or k == len(todo) - 1:
            el = time.time() - t0
            print(f'[{time.strftime("%H:%M:%S")}] shard {i + 1}/{n_shards}  {el / 60:.1f} min elapsed, '
                  f'~{el / (k + 1) * (len(todo) - k - 1) / 60:.1f} min left, free {free_gb():.1f}GB', flush=True)

    E = np.concatenate([np.load(os.path.join(out, f'shard_{i:04d}.npy')) for i in range(n_shards)])
    np.save(os.path.join(out, 'E.npy'), E)
    np.save(os.path.join(out, 'Qen.npy'), model.encode([qp + q['en'] for q in qs], normalize_embeddings=True))
    np.save(os.path.join(out, 'Qzh.npy'), model.encode([qp + q['q'] for q in qs], normalize_embeddings=True))
    json.dump([c['id'] for c in chunks], open(os.path.join(out, 'ids.json'), 'w'))
    print(f'{name}: done, E {E.shape}, total {(time.time() - t0) / 60:.1f} min', flush=True)


if __name__ == '__main__':
    main()
