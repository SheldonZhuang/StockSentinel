// 数据库每日备份到 GitHub 私有仓库（收费产品的数据兜底）
// 原理：GitHub Contents API PUT（base64），双写 dated 文件 + latest.db 滚动覆盖
// 需要环境变量（缺任一则静默跳过，不影响主链路）：
//   GITHUB_BACKUP_REPO   如 "SheldonZhuang/stocksentinel-backup"（必须是私有仓库）
//   GITHUB_BACKUP_TOKEN  fine-grained PAT，仅授予该仓库的 Contents: Read and write
import fs from 'fs';
import axios from 'axios';
import { DB_PATH } from './storage.js';

const API = 'https://api.github.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_BACKUP_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function putFile(repo, path, contentB64, message) {
  const url = `${API}/repos/${repo}/contents/${path}`;
  // 已存在的文件需要带当前 sha 才能覆盖
  let sha;
  try {
    const cur = await axios.get(url, { headers: headers(), timeout: 20000 });
    sha = cur.data?.sha;
  } catch (err) {
    if (err.response?.status !== 404) throw err; // 404=新文件，其余错误上抛
  }
  await axios.put(url, { message, content: contentB64, ...(sha ? { sha } : {}) }, {
    headers: headers(),
    timeout: 60000,
    maxBodyLength: Infinity,
  });
}

/**
 * 执行一次备份；返回 {ok|skipped, ...}，任何失败返回 {ok:false, error}（不抛）
 */
export async function backupDatabase() {
  const repo = process.env.GITHUB_BACKUP_REPO;
  if (!repo || !process.env.GITHUB_BACKUP_TOKEN) {
    return { skipped: true, reason: 'GITHUB_BACKUP_REPO / GITHUB_BACKUP_TOKEN not set' };
  }
  try {
    if (!fs.existsSync(DB_PATH)) return { ok: false, error: `db file not found: ${DB_PATH}` };
    const buf = fs.readFileSync(DB_PATH);
    const b64 = buf.toString('base64');
    const day = new Date().toISOString().slice(0, 10);
    const dated = `backups/${day.slice(0, 4)}/stock-sentinel-${day}.db`;

    await putFile(repo, dated, b64, `backup ${day}`);
    await putFile(repo, 'backups/latest.db', b64, `latest ${day}`);
    console.log(`[backup] database backed up to ${repo} (${(buf.length / 1024).toFixed(0)} KB)`);
    return { ok: true, sizeKb: Math.round(buf.length / 1024), paths: [dated, 'backups/latest.db'] };
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 150)}` : err.message;
    console.warn('[backup] failed:', msg);
    return { ok: false, error: msg };
  }
}
