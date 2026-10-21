"""向量对比实验的排队执行器（129号阶段2，用户 2026-10-21：「重跑，排队，请协调资源」）。

和其他项目协调的方式（沿用工作区约定）：
  - 排进共享的 render 锁（D:\\sheldonproject\\_shared\\locks\\render.busy），复用 NarratorForge 的 nf_lock.hold()：
    先来先到，同一时刻全机只有一个 CPU/内存大户（视频渲染或本实验）在跑；持锁进程退出即自动释放。
  - 进锁后 embed.py 每个分片前仍检查可用内存（启动前要求可用 ≥2.5GB、最多等 1 小时；之后每片只在可用 <1.2GB 时暂停），不和浏览器等常驻程序抢内存。
  - 用 pythonw 脱离 Claude Code 后台 shell 启动：内存吃紧时 harness 会回收自己的后台 shell（上次就是这样被停的），
    脱离运行的进程不受影响；分片续跑，就算被中断，重新启动也只补缺的部分。

顺序：bge 生成向量 → bge 评估 → e5 生成向量 → e5 评估。每一步失败暂停 5 分钟重试一次。
日志：<数据目录>/queue.log；最后一行是 "QUEUE DONE ok=<n> failed=<...>"。

用法：pythonw -I run_queue.py <数据目录>
"""
import datetime as dt
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NF_SCRIPTS = Path(r'D:\sheldonproject\NarratorForge\narrator-forge\scripts')
sys.path.insert(0, str(NF_SCRIPTS))
from nf_lock import hold  # noqa: E402

MIN_GB = 2.5


def main():
    data = Path(sys.argv[1]).resolve()
    log_path = data / 'queue.log'

    def log(msg):
        with log_path.open('a', encoding='utf-8') as f:
            f.write(f'{dt.datetime.now():%m-%d %H:%M:%S} {msg}\n')

    steps = [
        ('embed bge', [sys.executable, '-I', str(HERE / 'embed.py'), str(data), 'bge', str(MIN_GB)], None),
        ('eval bge', [sys.executable, '-I', str(HERE / 'evaluate.py'), str(data), 'bge'], data / 'result_bge.json'),
        ('embed e5', [sys.executable, '-I', str(HERE / 'embed.py'), str(data), 'e5', str(MIN_GB)], None),
        ('eval e5', [sys.executable, '-I', str(HERE / 'evaluate.py'), str(data), 'e5'], data / 'result_e5.json'),
    ]
    log(f'QUEUE START {len(steps)} steps; waiting for shared render lock')
    ok, failed = 0, []
    with hold('render', 'stocksentinel-vector-exp'):
        log('render lock acquired')
        for name, cmd, out_file in steps:
            for attempt in (1, 2):
                log(f'RUN {name} (try {attempt})')
                with (data / f'{name.replace(" ", "_")}.out').open('a', encoding='utf-8') as so:
                    if out_file:
                        with out_file.open('w', encoding='utf-8') as of:
                            r = subprocess.run(cmd, stdout=of, stderr=so, cwd=str(HERE))
                    else:
                        r = subprocess.run(cmd, stdout=so, stderr=subprocess.STDOUT, cwd=str(HERE))
                if r.returncode == 0:
                    ok += 1
                    log(f'   {name} ok')
                    break
                log(f'   {name} rc={r.returncode}; ' + ('retry in 5 min' if attempt == 1 else 'giving up'))
                if attempt == 1:
                    time.sleep(300)
                else:
                    failed.append(name)
    log(f'QUEUE DONE ok={ok} failed={failed or "none"}')


if __name__ == '__main__':
    main()
