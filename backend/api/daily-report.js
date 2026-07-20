// AI 日报：每日 cron 后用 LLM 把当日信号快照写成中英双语解读（获客内容引擎）
// 经 OpenRouter 调用（复用已有 OPENROUTER_API_KEY），模型可用 AI_REPORT_MODEL 覆盖
// 失败静默跳过——日报是增值内容，不能影响信号主链路
import axios from 'axios';
import { saveDailyReport } from '../utils/storage.js';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
// 默认模型实测（2026-07-13，本机区域）：OpenAI/Gemini 系列 403 区域受限，DeepSeek 中英双语质量好且价格低
const DEFAULT_MODEL = 'deepseek/deepseek-chat-v3-0324';

const SIGNAL_CN = { attack: '进攻', neutral: '观望', reduce: '减仓观望', defense: '防守', loose: '宽松', tight: '收紧' };

function buildFacts(payload) {
  const i = payload.indicators || {};
  const fmt = (v, d = 1) => (v === null || v === undefined ? '无数据' : Number(v).toFixed(d));
  return [
    `最终信号: ${SIGNAL_CN[payload.finalSignal] || payload.finalSignal}`,
    `四维: AI供需=${SIGNAL_CN[payload.aiSupplySignal]}，货币=${SIGNAL_CN[payload.monetarySignal]}，财政=${SIGNAL_CN[payload.fiscalSignal]}，行政=${SIGNAL_CN[payload.adminSignal]}`,
    `AI供需: 模型调用量趋势${fmt(i.modelUsageTrendPct)}%，云厂商capex滚动4季同比${fmt(i.capexYoY)}%${i.capexQtrYoY != null ? `（最新单季${i.capexQtrEnd || ''}同比${fmt(i.capexQtrYoY)}%，单季先于TTM反映拐点）` : ''}，半导体产出同比${fmt(i.semiIpYoy)}%${i.aiBubbleWarning ? '，⚠️泡沫预警触发' : ''}`,
    `货币: 联邦基金利率${fmt(i.rate, 2)}%，资产负债表状态=${i.balanceSheetStatus || '无数据'}，萨姆值${fmt(i.sahmValue, 2)}${i.sahmLockActive ? '（萨姆锁激活）' : ''}${i.reactiveAdjustmentLockActive ? '（应对式调整锁激活）' : ''}`,
    `财政: 联邦支出TTM同比${fmt(i.fiscalOutlaysChangePct)}%`,
    `行政: WTI 30天${fmt(i.oilChange30dPct)}%（${i.oilSource || '无数据'}），日频EPU百分位${fmt(i.epuDailyPercentile, 0)}，贸易EPU百分位${fmt(i.epuTradePercentile, 0)}`,
    `判定规则: 进攻=四维全宽松且无锁；仅单维收紧=减仓观望；双维以上收紧或锁激活=全面防守`,
  ].join('\n');
}

function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object in LLM output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * 生成并保存当日日报；成功返回 {zh, en}，任何失败返回 null（不抛）
 * LLM 偶发输出非 JSON（实测 2026-07-17/19/20 三次），失败自动重试一次
 */
export async function generateDailyReport(payload, attempt = 1) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !payload) return null;
  const model = process.env.AI_REPORT_MODEL || DEFAULT_MODEL;

  try {
    const res = await axios.post(OPENROUTER_CHAT_URL, {
      model,
      messages: [
        {
          role: 'system',
          content: '你是严谨的金融数据编辑。基于给定的信号系统输出撰写客观的每日解读，只陈述数据与系统判定逻辑，不做预测、不给出买卖建议、不使用煽动性措辞。',
        },
        {
          role: 'user',
          content: `以下是美股进攻/防守信号系统今日（${payload.dataDate}）的输出：\n\n${buildFacts(payload)}\n\n请输出 JSON（只输出JSON，无其他文字）：{"zh": "中文日报", "en": "English daily brief"}。每种语言120~180字：第一句给出今日档位；然后解释是哪些维度、什么数据导致了这个档位；指出距离进攻档还差什么条件（或防守由什么触发）；最后一句固定为免责声明（中文"本内容仅供研究参考，不构成投资建议。"/英文"For research reference only, not investment advice."）。`,
        },
      ],
      temperature: 0.3,
    }, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 60000,
    });

    const text = res.data?.choices?.[0]?.message?.content;
    const { zh, en } = parseJsonLoose(text);
    if (!zh || !en) throw new Error('missing zh/en in LLM output');

    await saveDailyReport({ date: payload.dataDate, contentZh: zh, contentEn: en, model });
    console.log(`[daily-report] generated for ${payload.dataDate} via ${model}`);
    return { zh, en };
  } catch (err) {
    console.warn(`[daily-report] generation failed (attempt ${attempt}):`, err?.message || String(err).slice(0, 120));
    if (attempt < 2) return generateDailyReport(payload, attempt + 1);
    return null;
  }
}
