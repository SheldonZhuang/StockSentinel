// 研究 Agent 事件驱动管线（129号阶段5）：新财报落地 → 增量采集 → Wiki 增量 → 生成笔记（初版 / 正式版）。
// 挂在 server.js 的小时看门狗上，与现有补跑机制同一模式：进程内互斥、失败不抛（只告警）、下一小时自动重试。
//
// 开关与范围（默认关，部署不会自动开跑）：
//   RESEARCH_ENABLED=1        打开（只在 primary 实例跑；replica 本机实例除非 RESEARCH_ON_REPLICA=1）
//   RESEARCH_TICKERS=MSFT,... 限定公司（默认 8 家全部）
// 笔记生成规则（用户 2026-10-21 定）：
//   - 某季只有 8-K / TSM 财报新闻稿 → 生成初版（preliminary）；10-Q / 10-K / TSM 季度合并财报落地 → 生成正式版（final）
//   - 只为"最近一个财季"自动生成；历史季度不自动回填（要的话手动跑 scripts/research-note.mjs）
//   - 已有同阶段（且成功或待核对）的线上笔记就不重复生成；上次失败的会在下一小时重试，同一季每天最多 3 次
//   - 模型与预算：research/models.js（Claude 优先、Grok 兜底）+ llm.js 日常池上限（$0.5/日、$5/月，80% 后降到 Grok）
import cfg from '../config/research.config.js';
import { getResearchDb, all, get } from './db.js';
import { runIngest } from './ingest.js';
import { updateWiki } from './wiki.js';
import { generateNote, quarterFilings } from './agent.js';
import { invalidateSearchIndex } from './search.js';
import { sendAdminNotice } from '../utils/mailer.js';

const MAX_FAILED_PER_DAY = 3;
let running = false;

export function researchEnabled(env = process.env) {
  if (env.RESEARCH_ENABLED !== '1') return false;
  const replica = (env.INSTANCE_ROLE || 'primary') === 'replica';
  return !replica || env.RESEARCH_ON_REPLICA === '1';
}

export function researchTickers(env = process.env) {
  const all8 = Object.keys(cfg.RESEARCH_COMPANIES);
  const pick = String(env.RESEARCH_TICKERS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return pick.length ? pick.filter(t => all8.includes(t)) : all8;
}

/**
 * 某公司最近一个财季要不要生成笔记、生成哪一版（纯判定，读库）。
 * @returns {{fiscalLabel, stage, reason}|null}
 */
export function noteDue(ticker, today = new Date().toISOString().slice(0, 10)) {
  const latest = get(`SELECT fiscal_year fy, fiscal_quarter fq FROM filings WHERE ticker = ? AND status = 'parsed'
                      ORDER BY fiscal_year DESC, fiscal_quarter DESC LIMIT 1`, [ticker]);
  if (!latest) return null;
  const fiscalLabel = `FY${latest.fy}Q${latest.fq}`;
  const { stage } = quarterFilings(ticker, fiscalLabel);
  const have = all(`SELECT stage, status, substr(created_at,1,10) AS day FROM research_notes
                    WHERE ticker = ? AND fiscal_label = ? AND eval_run IS NULL ORDER BY id DESC`, [ticker, fiscalLabel]);
  // 已有该阶段的可用笔记（ok / needs_review）→ 不重复生成；正式版到了而只有初版 → 生成正式版
  if (have.some(n => n.stage === stage && n.status !== 'failed')) return null;
  if (stage === 'preliminary' && have.some(n => n.stage === 'final' && n.status !== 'failed')) return null;
  const failedToday = have.filter(n => n.stage === stage && n.status === 'failed' && n.day === today).length;
  if (failedToday >= MAX_FAILED_PER_DAY) return null;
  return { fiscalLabel, stage, reason: have.length ? `${stage} missing (have: ${have.map(n => `${n.stage}/${n.status}`).join(',')})` : 'no note yet' };
}

/**
 * 一轮：采集 → Wiki → 笔记。互斥；任何一步失败只记日志并告警，不抛给 cron。
 * @returns 本轮摘要
 */
export async function runResearchPipeline({ trigger = 'watchdog', log = console.log } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const summary = { trigger, ingest: null, wiki: null, notes: [] };
  try {
    await getResearchDb();
    const tickers = researchTickers();
    summary.ingest = await runIngest({ tickers, trigger, log: () => {} });
    if (summary.ingest.newFilings) invalidateSearchIndex();
    // Wiki 增量：只处理新入库、尚未进 Wiki 的申报（处理过的不再花钱）
    summary.wiki = await updateWiki({ tickers, pool: 'research', log: () => {} });
    for (const t of tickers) {
      const due = noteDue(t);
      if (!due) continue;
      const row = await generateNote({ ticker: t, fiscalLabel: due.fiscalLabel, pool: 'research', log: () => {} });
      summary.notes.push({ ticker: t, fiscalLabel: due.fiscalLabel, stage: due.stage, status: row.status, model: row.model, cost: row.cost_usd, error: row.error || null });
      log(`[research] note ${t} ${due.fiscalLabel} ${due.stage}: ${row.status} via ${row.model} $${(row.cost_usd || 0).toFixed(4)}`);
      if (row.status === 'failed' && /budget/i.test(row.error || '')) break; // 预算停了，后面的也会停
    }
    if (summary.ingest.newFilings || summary.notes.length) log(`[research] pipeline: ${JSON.stringify({ newFilings: summary.ingest.newFilings, wiki: summary.wiki?.processed, notes: summary.notes.length })}`);
    return summary;
  } catch (err) {
    summary.error = err.message;
    log(`[research] pipeline failed: ${err.message}`);
    await sendAdminNotice(process.env.ADMIN_EMAIL, { subject: '研究管线本轮失败', lines: [err.message, '下一小时看门狗会自动重试。'] }).catch(() => {});
    return summary;
  } finally {
    running = false;
  }
}

export const isResearchPipelineRunning = () => running;
