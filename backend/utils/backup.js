// 数据库每日备份到 GitHub 私有仓库（收费产品的数据兜底）
// 原理：GitHub Contents API PUT（base64），双写 dated 文件 + latest.db 滚动覆盖
// 需要环境变量（缺任一则静默跳过，不影响主链路）：
//   GITHUB_BACKUP_REPO   如 "SheldonZhuang/stocksentinel-backup"（必须是私有仓库）
//   GITHUB_BACKUP_TOKEN  fine-grained PAT，仅授予该仓库的 Contents: Read and write
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { DB_PATH, getLatestSnapshot } from './storage.js';

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

async function getFileJson(repo, path) {
  try {
    const url = `${API}/repos/${repo}/contents/${path}`;
    const res = await axios.get(url, { headers: headers(), timeout: 20000 });
    return JSON.parse(Buffer.from(res.data.content.replace(/\n/g, ''), 'base64').toString('utf8'));
  } catch {
    return null; // 404/解析失败 → 无守卫信息，按无远端处理
  }
}

// 用户侧写入（注册/自选股/override/API key）的防抖即时备份：
// GitHub 备份原本只在每日 cron 末尾跑一次，Railway 文件系统非持久化时，
// "上次备份之后~下次重部署之前"的用户写入会永久丢失（最长24小时窗口）。
// 防抖60秒把窗口收窄到分钟级；备份自身失败静默（下一次写入或明日 cron 会再试）。
let userBackupTimer = null;
export function scheduleUserDataBackup(delayMs = 60000) {
  if (userBackupTimer) return;
  userBackupTimer = setTimeout(() => {
    userBackupTimer = null;
    backupDatabase().catch(() => {});
  }, delayMs);
  userBackupTimer.unref?.(); // 不阻止进程退出
}

/**
 * 启动时恢复：DB 文件不存在且备份配置齐全时，从 GitHub 拉回 latest.db。
 * 动机：Railway 容器文件系统非持久化，重部署即丢库——track record（收费产品核心资产）
 * 依赖每日备份兜底，但此前只有上传没有恢复路径，重部署后是从空库重新积累。
 * 必须在任何 getDb() 调用之前执行（storage 是懒加载，server 启动链首个查询前调用即可）。
 * 本地已有 DB 文件时不动（本地开发不被云端备份覆盖）。
 * @returns {{restored|skipped: boolean, reason?: string}}
 */
export async function restoreDatabaseIfMissing() {
  const repo = process.env.GITHUB_BACKUP_REPO;
  if (!repo || !process.env.GITHUB_BACKUP_TOKEN) {
    return { skipped: true, reason: 'backup env not set' };
  }
  if (fs.existsSync(DB_PATH)) return { skipped: true, reason: 'db file exists' };
  try {
    const url = `${API}/repos/${repo}/contents/backups/latest.db`;
    const res = await axios.get(url, { headers: headers(), timeout: 60000 });
    const b64 = res.data?.content;
    if (!b64) return { skipped: true, reason: 'no latest.db in backup repo' };
    const buf = Buffer.from(b64.replace(/\n/g, ''), 'base64');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // 与 storage.persist 同款原子写：写临时文件再改名
    const tmpPath = `${DB_PATH}.restore.tmp`;
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, DB_PATH);
    console.log(`[backup] database restored from ${repo} (${(buf.length / 1024).toFixed(0)} KB)`);
    return { restored: true, sizeKb: Math.round(buf.length / 1024) };
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return { skipped: true, reason: 'no backup found (fresh deployment)' };
    console.warn('[backup] restore failed (starting with empty db):', err.message);
    return { skipped: true, reason: err.message };
  }
}

/**
 * 执行一次备份；返回 {ok|skipped, ...}，任何失败返回 {ok:false, error}（不抛）
 * 新旧容器竞态守卫：滚动部署重叠期两个容器都会跑备份，若旧容器较后完成会用旧库
 * 覆盖新库的 latest.db——上传前比较远端 meta 的快照日期，本地更旧则跳过 latest.db。
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
    const localSnapDate = (await getLatestSnapshot().catch(() => null))?.date || null;

    await putFile(repo, dated, b64, `backup ${day}`);

    const remoteMeta = await getFileJson(repo, 'backups/latest.meta.json');
    if (remoteMeta?.snapshotDate && localSnapDate && remoteMeta.snapshotDate > localSnapDate) {
      console.warn(`[backup] skip latest.db: remote snapshot ${remoteMeta.snapshotDate} newer than local ${localSnapDate}`);
      return { ok: true, sizeKb: Math.round(buf.length / 1024), paths: [dated], latestSkipped: true };
    }
    await putFile(repo, 'backups/latest.db', b64, `latest ${day}`);
    await putFile(repo, 'backups/latest.meta.json',
      Buffer.from(JSON.stringify({ snapshotDate: localSnapDate, backedUpAt: new Date().toISOString() })).toString('base64'),
      `meta ${day}`);
    console.log(`[backup] database backed up to ${repo} (${(buf.length / 1024).toFixed(0)} KB)`);
    return { ok: true, sizeKb: Math.round(buf.length / 1024), paths: [dated, 'backups/latest.db'] };
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 150)}` : err.message;
    console.warn('[backup] failed:', msg);
    return { ok: false, error: msg };
  }
}
