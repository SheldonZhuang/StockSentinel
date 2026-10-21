// 中文研究问题 → 检索请求（129号阶段2，确定性规则，零成本、可复现）：
//   公司名 → ticker；"2026 财年第一季度" / "FY2026Q1" / "2026 年第三季度" → 财年+财季；
//   财务术语 → 英文检索词 + 话题标签 + 章节偏好。问题里本来就有的英文词（Azure、Blackwell）原样保留。
// 不用 LLM 改写：检索评估要可复现，规则表的盲区在评估里直接暴露，比模型改写好排查。

export const COMPANY_ALIASES = [
  [/微软|microsoft|\bmsft\b/i, 'MSFT'],
  [/谷歌|alphabet|google|\bgoogl?\b/i, 'GOOGL'],
  [/亚马逊|amazon|\bamzn\b/i, 'AMZN'],
  [/\bmeta\b|脸书|facebook/i, 'META'],
  [/英伟达|nvidia|\bnvda\b/i, 'NVDA'],
  [/\bamd\b|超威/i, 'AMD'],
  [/博通|broadcom|\bavgo\b/i, 'AVGO'],
  [/台积电|tsmc|\btsm\b/i, 'TSM'],
];

// [中文触发词, 英文检索词, 话题, 章节偏好]
const GLOSSARY = [
  // 各家现金流量表科目写法不同：Purchases of（AMZN/META/GOOGL）/ Additions to（MSFT）property and equipment
  [/资本开支|资本支出|capex/i, 'capital expenditures purchases additions property equipment', 'capex', null],
  [/营收|收入|销售额|revenue|net sales/i, 'revenue net sales total', null, null],
  [/增长|增速|同比|增幅/, 'increased grew growth year-over-year', null, null],
  [/分部|业务板块|segment/i, 'segment', 'segment_revenue', null],
  [/毛利率/, 'gross margin', null, null],
  [/毛利(?!率)/, 'gross profit margin', null, null],
  [/营业利润|经营利润|operating income/i, 'operating income', null, null],
  [/净利润|净利|net income/i, 'net income', null, null],
  [/研发/, 'research development', null, null],
  [/指引|展望|预计|预期|guidance|outlook/i, 'outlook expect guidance', 'guidance', null],
  [/下季度|下一季度|第[一二三四1-4]季度.*(指引|展望|预计)/, 'next quarter expect', 'guidance', null],
  [/全年|全财年/, 'full year', null, null],
  [/数据中心/, 'data center', null, null],
  [/云/, 'cloud', null, null],
  [/广告/, 'advertising', null, null],
  [/风险/, 'risk', null, ['risk_factors']],
  [/出口管制|出口限制/, 'export controls license', null, null],
  [/中国/, 'china', null, null],
  [/关税/, 'tariff', null, null],
  [/晶圆/, 'wafer', null, null],
  [/(\d+)\s*纳米|nm\b/i, 'nanometer', null, null],
  [/回购/, 'repurchase', null, null],
  [/股息|分红/, 'dividend', null, null],
  [/库存|存货/, 'inventory', null, null],
  [/员工|雇员/, 'employees headcount', null, null],
  [/人工智能|\bai\b/i, 'ai', null, null],
  [/租赁/, 'finance leases', null, null],
];

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 1: 1, 2: 2, 3: 3, 4: 4 };

/** 财期解析：返回 { fiscalYear, fiscalQuarter } 中能识别的部分 */
export function parsePeriod(q) {
  let m = /FY\s*(\d{4})\s*Q([1-4])/i.exec(q);
  if (m) return { fiscalYear: Number(m[1]), fiscalQuarter: Number(m[2]) };
  m = /(\d{4})\s*(?:财年|年)?\s*(?:第\s*)?([一二三四1-4])\s*(?:财季|季度|季)/.exec(q);
  if (m) return { fiscalYear: Number(m[1]), fiscalQuarter: CN_NUM[m[2]] };
  m = /(\d{4})\s*Q([1-4])/i.exec(q);
  if (m) return { fiscalYear: Number(m[1]), fiscalQuarter: Number(m[2]) };
  m = /(\d{4})\s*(?:财年|年)/.exec(q);
  // 只问全年（"2026财年全年资本开支"）：全年数字披露在年报里，年报归属财年 Q4
  if (m) return /全年|全财年|年度/.test(q) ? { fiscalYear: Number(m[1]), fiscalQuarter: 4 } : { fiscalYear: Number(m[1]) };
  return {};
}

/**
 * @returns {{ tickers: string[], fiscalYear?, fiscalQuarter?, terms: string, topics: string[], sections: string[]|null }}
 */
export function parseQuestion(q) {
  const tickers = COMPANY_ALIASES.filter(([re]) => re.test(q)).map(([, t]) => t);
  const words = [];
  const topics = new Set();
  let sections = null;
  for (const [re, en, topic, secs] of GLOSSARY) {
    const m = re.exec(q);
    if (!m) continue;
    words.push(en);
    if (/纳米/.test(m[0]) && m[1]) words.push(m[1]); // "3纳米" → 保留数字 3
    if (topic) topics.add(topic);
    if (secs) sections = secs;
  }
  // 问题里的英文专名（Azure / AWS / Blackwell / Intelligent Cloud）原样加入；公司名本身不加（已转成过滤条件）
  const english = (q.match(/[A-Za-z][A-Za-z0-9&.-]*/g) || [])
    .filter(w => !/^(FY\d*|Q[1-4]|msft|googl?|amzn|meta|nvda|amd|avgo|tsm|tsmc|microsoft|google|alphabet|amazon|nvidia|broadcom|capex|ai)$/i.test(w));
  words.push(...english);
  return { tickers, ...parsePeriod(q), terms: words.join(' '), topics: [...topics], sections };
}
