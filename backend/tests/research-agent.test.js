// 研究 Agent（129号阶段3）：Inline XBRL 解析、指标表（单季/YTD 差分/毛利推算）、逐条自检、Agent 多步流程（模拟 LLM）
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-agent-'));
process.env.RESEARCH_DB_PATH = path.join(tmp, 'research.db');
process.env.RESEARCH_FILINGS_DIR = path.join(tmp, 'filings');

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../research/llm.js', async importOriginal => ({ ...(await importOriginal()), chat }));
// 股哨兵主库不参与：背景信息给固定文本
vi.mock('../api/payloads.js', () => ({
  buildSignalPayload: async () => ({ dataDate: '2026-10-20', finalSignal: 'reduce', aiSupplySignal: 'loose', monetarySignal: 'tight', fiscalSignal: 'neutral', adminSignal: 'tight' }),
  buildAiChainPayload: async () => ({ stages: [], guidance: [] }),
}));

const db = await import('../research/db.js');
const { parseInlineXbrl, indexFilingIxbrl } = await import('../research/ixbrl.js');
const { buildMetricTable, memberLabel } = await import('../research/metrics.js');
const { verifyClaim, numbersIn } = await import('../research/verify.js');
const { generateNote } = await import('../research/agent.js');
const { invalidateSearchIndex } = await import('../research/search.js');
await db.getResearchDb();

afterAll(() => { db._closeResearchDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- 夹具：一份 iXBRL 片段生成器 ----
const ctx = (id, start, end, member) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier>${member ? `<xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">t:${member}</xbrldi:explicitMember></xbrli:segment>` : ''}</xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
const fact = (name, ctxId, text, extra = '') => `<ix:nonFraction name="${name}" contextRef="${ctxId}" unitRef="usd" scale="6" decimals="-6"${extra}>${text}</ix:nonFraction>`;
const doc = parts => `<html><body><ix:header><ix:resources><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>${parts.ctx.join('')}</ix:resources></ix:header>${parts.facts.join(' ')}</body></html>`;

describe('parseInlineXbrl', () => {
  it('scale / sign / 千分位 / 维度 / 重复去重 / fixed-zero', () => {
    const html = doc({
      ctx: [ctx('q', '2026-04-01', '2026-06-30'), ctx('s', '2026-04-01', '2026-06-30', 'CloudMember')],
      facts: [
        fact('us-gaap:Revenues', 'q', '<span>1,234</span>'),
        fact('us-gaap:Revenues', 'q', '9,999'), // 同一事实第二次出现：取首个
        fact('us-gaap:OperatingIncomeLoss', 'q', '50', ' sign="-"'),
        fact('us-gaap:Revenues', 's', '400'),
        fact('us-gaap:Other', 'q', '—', ' format="ixt:fixed-zero"'),
      ],
    });
    const facts = parseInlineXbrl(html);
    const by = (c, d = '') => facts.find(f => f.concept === c && f.dims === d);
    expect(by('us-gaap:Revenues').value).toBe(1234e6);
    expect(by('us-gaap:OperatingIncomeLoss').value).toBe(-50e6);
    expect(by('us-gaap:Revenues', 'us-gaap:StatementBusinessSegmentsAxis=t:CloudMember').value).toBe(400e6);
    expect(by('us-gaap:Other').value).toBe(0);
    expect(facts.filter(f => f.concept === 'us-gaap:Revenues' && !f.dims)).toHaveLength(1);
    expect(by('us-gaap:Revenues').unit).toBe('USD');
  });

  it('成员名转可读', () => {
    expect(memberLabel('msft:IntelligentCloudMember')).toBe('Intelligent Cloud');
    expect(memberLabel('amzn:AmazonWebServicesSegmentMember')).toBe('Amazon Web Services');
    expect(memberLabel('msft:MicrosoftThreeSixFiveCommercialProductsAndCloudServicesMember')).toMatch(/^Microsoft 365 Commercial/);
  });
});

// ---- 一家公司三份定期报告：Q2（去年）、Q1、Q2（今年），Q2 现金流只有 6M YTD ----
function seedPeriodic(acc, fy, fq, end, html, filingDate) {
  db.run(`INSERT INTO filings (accession, ticker, cik, form_type, doc_kind, filing_date, period_end, fiscal_year, fiscal_quarter, document, document_url, status, fetched_at)
          VALUES (?, 'TCO', '1', '10-Q', 'periodic', ?, ?, ?, ?, 'x.htm', ?, 'parsed', 'x')`, [acc, filingDate, end, fy, fq, `https://sec.gov/${acc}/x.htm`]);
  fs.mkdirSync(path.join(process.env.RESEARCH_FILINGS_DIR, acc), { recursive: true });
  fs.writeFileSync(path.join(process.env.RESEARCH_FILINGS_DIR, acc, 'x.htm.gz'), zlib.gzipSync(html));
  return indexFilingIxbrl(db.get('SELECT * FROM filings WHERE accession = ?', [acc]));
}
const quarterDoc = ({ end, start, prevYearEnd, prevYearStart, rev, revPY, cor, corPY, seg, segPY, capexYtd, capexYtdPY, ytdStart, ytdStartPY }) => doc({
  ctx: [ctx('c', start, end), ctx('p', prevYearStart, prevYearEnd), ctx('cs', start, end, 'CloudMember'), ctx('ps', prevYearStart, prevYearEnd, 'CloudMember'),
    ctx('y', ytdStart, end), ctx('yp', ytdStartPY, prevYearEnd)],
  facts: [fact('us-gaap:Revenues', 'c', rev), fact('us-gaap:Revenues', 'p', revPY), fact('us-gaap:CostOfRevenue', 'c', cor), fact('us-gaap:CostOfRevenue', 'p', corPY),
    fact('us-gaap:Revenues', 'cs', seg), fact('us-gaap:Revenues', 'ps', segPY),
    fact('us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'y', capexYtd), fact('us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'yp', capexYtdPY)],
});

describe('buildMetricTable', () => {
  beforeAll(() => {
    seedPeriodic('q1-26', 2026, 1, '2026-03-31', quarterDoc({ end: '2026-03-31', start: '2026-01-01', prevYearEnd: '2025-03-31', prevYearStart: '2025-01-01', rev: '1,000', revPY: '800', cor: '400', corPY: '360', seg: '300', segPY: '200', capexYtd: '100', capexYtdPY: '70', ytdStart: '2026-01-01', ytdStartPY: '2025-01-01' }), '2026-04-30');
    seedPeriodic('q2-26', 2026, 2, '2026-06-30', quarterDoc({ end: '2026-06-30', start: '2026-04-01', prevYearEnd: '2025-06-30', prevYearStart: '2025-04-01', rev: '1,200', revPY: '900', cor: '450', corPY: '400', seg: '420', segPY: '250', capexYtd: '250', capexYtdPY: '150', ytdStart: '2026-01-01', ytdStartPY: '2025-01-01' }), '2026-07-30');
  });

  it('本季 / 上季 / 去年同期 / 变化率；毛利 = 收入 − 成本；毛利率给百分点差', () => {
    const t = buildMetricTable('TCO', 2026, 2);
    const m = id => t.metrics.find(x => x.id === id);
    expect(m('revenue')).toMatchObject({ current: 1200e6, prior_quarter: 1000e6, prior_year: 900e6, qoq_pct: 20, yoy_pct: 33.3 });
    expect(m('gross_profit')).toMatchObject({ current: 750e6, prior_quarter: 600e6, prior_year: 500e6 });
    expect(m('gross_profit').source.derived).toBe('营业收入 − 营业成本');
    expect(m('gross_margin')).toMatchObject({ current: 62.5, prior_quarter: 60, prior_year: 55.6, qoq_pp: 2.5, yoy_pp: 6.9 });
    expect(m('segment:t:CloudMember')).toMatchObject({ current: 420e6, prior_year: 250e6, yoy_pct: 68 });
    expect(t.priorQuarter).toBe('FY2026Q1');
  });

  it('现金流只有 YTD：单季 = 6M − 3M（上一份申报），标 derived', () => {
    const capex = buildMetricTable('TCO', 2026, 2).metrics.find(x => x.id === 'capex');
    expect(capex.current).toBe(150e6);
    expect(capex.source.derived).toMatch(/6M YTD \(q2-26\) − 3M YTD \(q1-26\)/);
  });

  it('只有 8-K 的季度没有指引表', () => {
    expect(buildMetricTable('TCO', 2026, 3)).toBe(null);
  });
});

describe('verifyClaim', () => {
  const metricsById = new Map([['revenue', { id: 'revenue', label: '营业收入', unit: 'USD', current: 90.007e9, prior_quarter: 82.886e9, prior_year: 76.441e9, qoq_pct: 8.6, yoy_pct: 17.7, source: {} }]]);
  const chunk = { id: 7, ticker: 'MSFT', accession: 'a', form_type: '8-K', section: 'press_release', char_start: 1000, char_end: 1100, source_url: 'u', text: 'Revenue was $90.0 billion and increased 18%.' };
  const v = c => verifyClaim(c, { ticker: 'MSFT', metricsById, chunksById: new Map([[7, chunk]]) });

  it('数字来自指标表（格式化或变化率）→ 通过', () => {
    expect(v({ text: '营业收入 $90.0B，同比增长 17.7%', evidence: [{ metric: 'revenue' }] }).ok).toBe(true);
    expect(v({ text: '营业收入 90,007 百万美元', evidence: [{ metric: 'revenue' }] }).ok).toBe(true);
    expect(v({ text: 'FY2026Q4 营业收入 90.01 十亿美元', evidence: [{ metric: 'revenue' }] }).ok).toBe(true);
  });

  it('数字来自逐字引文 → 通过，并给出绝对字符区间', () => {
    const r = v({ text: '收入 90.0 十亿美元，增长 18%', evidence: [{ chunk_id: 7, quote: 'Revenue was $90.0 billion and increased 18%' }] });
    expect(r.ok).toBe(true);
    expect(r.evidence[0].char_range).toEqual([1000, 1043]);
  });

  it('自己写的数字 / 找不到的引文 / 没出处 / 别家公司的块 / 买卖建议 → 不通过', () => {
    expect(v({ text: '收入 91.2 十亿美元', evidence: [{ metric: 'revenue' }] }).reasons).toContain('数字 91.2 在所引出处里找不到');
    expect(v({ text: '收入增长', evidence: [{ chunk_id: 7, quote: 'Revenue was $95.0 billion' }] }).ok).toBe(false);
    expect(v({ text: '收入增长', evidence: [] }).reasons).toContain('没有出处');
    expect(verifyClaim({ text: '收入增长', evidence: [{ chunk_id: 7, quote: 'Revenue was $90.0 billion' }] }, { ticker: 'NVDA', metricsById, chunksById: new Map([[7, chunk]]) }).ok).toBe(false);
    expect(v({ text: '建议买入，目标价 600', evidence: [{ metric: 'revenue' }] }).reasons[0]).toMatch(/买卖建议/);
  });

  it('财年/季度标签与年份不算需要核对的数字', () => {
    expect(numbersIn('FY2026Q4 收入较 2025 年第四季度增长 17.7%')).toEqual(['17.7']);
  });
});

describe('generateNote（模拟 LLM）', () => {
  beforeAll(() => {
    db.run(`INSERT INTO chunks (accession, ticker, form_type, filing_date, period_end, section, seq, char_start, char_end, topics, source_url, text)
            VALUES ('q2-26','TCO','10-Q','2026-07-30','2026-06-30','risk_factors',0,0,80,'','https://sec.gov/q2-26/x.htm','Export controls could limit our ability to sell products in China.')`);
    invalidateSearchIndex();
  });
  beforeEach(() => { chat.mockReset(); db.run('DELETE FROM research_notes'); });

  const call = (name, args, id = `c${Math.random()}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const reply = toolCalls => ({ text: '', message: { content: '', tool_calls: toolCalls }, toolCalls, tokensIn: 1000, tokensOut: 200, costUsd: 0.001, model: 'm' });
  const goodRisk = { text: '出口管制可能限制在中国的销售', evidence: [{ chunk_id: null, quote: 'Export controls could limit our ability to sell products in China' }] };

  it('检索 → 交稿 → 自检失败回喂 → 改正后通过；数字区由程序生成；记账', async () => {
    let chunkId;
    chat
      .mockImplementationOnce(async () => reply([call('search_filings', { query: 'export controls China', section: 'risk_factors' })]))
      .mockImplementationOnce(async ({ messages }) => {
        chunkId = Number(/<chunk id="(\d+)"/.exec(messages.at(-1).content)[1]);
        return reply([call('submit_note', {
          summary: '收入同比增长 33.3%。',
          highlights: [{ text: '营业收入同比增长 33.3%', evidence: [{ metric: 'revenue' }] }, { text: '云分部收入 4.5 亿美元', evidence: [{ metric: 'segment:t:CloudMember' }] }],
          guidance_check: [], changes: [], risks: [{ ...goodRisk, evidence: [{ chunk_id: chunkId, quote: goodRisk.evidence[0].quote }] }],
        })]);
      })
      .mockImplementationOnce(async ({ messages }) => {
        expect(messages.at(-1).content).toMatch(/Self-check failed[\s\S]*数字 4.5/);
        return reply([call('submit_note', {
          summary: '收入同比增长 33.3%。',
          highlights: [{ text: '营业收入同比增长 33.3%', evidence: [{ metric: 'revenue' }] }, { text: '云分部收入 420.0 百万美元，同比增长 68%', evidence: [{ metric: 'segment:t:CloudMember' }] }],
          guidance_check: [], changes: [], risks: [{ ...goodRisk, evidence: [{ chunk_id: chunkId, quote: goodRisk.evidence[0].quote }] }],
        })]);
      });
    const row = await generateNote({ ticker: 'TCO', fiscalLabel: 'FY2026Q2', log: () => {} });
    expect(row.status).toBe('ok');
    expect(row.llm_calls).toBe(3);
    expect(row.cost_usd).toBeCloseTo(0.003);
    const note = JSON.parse(row.note_json);
    expect(note.stage).toBe('final');
    expect(note.key_figures.find(k => k.id === 'revenue').value).toBe(1200e6);
    expect(note.highlights.every(c => c.status === 'verified')).toBe(true);
    expect(note.risks[0].evidence[0]).toMatchObject({ type: 'text', section: 'risk_factors', url: 'https://sec.gov/q2-26/x.htm' });
    expect(note.disclaimer).toMatch(/不构成投资建议/);
    expect(row.note_md).toMatch(/## 关键数字（XBRL）/);
    // 每个 tool_call 都有对应的 tool 消息（OpenAI 协议要求，否则下一轮请求会被拒）
    const msgs = chat.mock.calls.at(-1)[0].messages;
    const ids = msgs.flatMap(m => m.tool_calls?.map(t => t.id) || []);
    for (const id of ids) expect(msgs.some(m => m.role === 'tool' && m.tool_call_id === id)).toBe(true);
  });

  it('重试后仍不通过：保留该条并标待人工核对，整份 needs_review', async () => {
    const bad = { summary: '收入大增。', highlights: [{ text: '收入 99 亿', evidence: [{ metric: 'revenue' }] }], guidance_check: [], changes: [], risks: [] };
    chat.mockImplementation(async () => reply([call('submit_note', bad)]));
    const row = await generateNote({ ticker: 'TCO', fiscalLabel: 'FY2026Q2', log: () => {} });
    expect(row.status).toBe('needs_review');
    const note = JSON.parse(row.note_json);
    expect(note.highlights[0]).toMatchObject({ status: 'needs_review' });
    expect(row.note_md).toMatch(/🔴 \*\*待人工核对\*\*/);
  });

  it('账户余额不足（402）：记 failed 行，不抛', async () => {
    chat.mockRejectedValue(Object.assign(new Error('402'), { response: { status: 402 } }));
    const row = await generateNote({ ticker: 'TCO', fiscalLabel: 'FY2026Q2', log: () => {} });
    expect(row).toMatchObject({ status: 'failed', error: '402' });
  });
});

// 2026-10-21 首次真实运行回归：笔记用"亿/万"写数字，出处是 $B / million，核对要按单位换算比，
// 不能误判通过，也不能误判失败（MSFT 初稿 17 条里 9 条是单位换算造成的假失败）
describe('verifyClaim 单位换算', async () => {
  const { verifyClaim: vc, quantitiesIn } = await import('../research/verify.js');
  const metric = { id: 'revenue', label: '营业收入', unit: 'USD', current: 90007e6, prior_quarter: 82886e6, prior_year: 76441e6, qoq_pct: 8.6, yoy_pct: 17.7 };
  const chunk = { id: 9, ticker: 'MSFT', accession: 'a', form_type: '8-K', section: 'press_release', char_start: 0, char_end: 200, source_url: 'u',
    text: 'Azure revenue surpassed $100 billion for the first time, and Microsoft 365 Copilot reached over 30 million paid seats.' };
  const ctx = { ticker: 'MSFT', metricsById: new Map([['revenue', metric]]), chunksById: new Map([[9, chunk]]) };
  const ok = (text, evidence) => vc({ text, evidence }, ctx).ok;

  it('quantitiesIn：亿/万/billion/百分比换算，财年季度标签不算', () => {
    expect(quantitiesIn('营收900.1亿美元，同比增长17.7%，FY2026Q4 第四季度').map(q => [q.v, q.pct])).toEqual([[90.01e9, false], [17.7, true]]);
    expect(quantitiesIn('超过3000万')[0].v).toBe(3e7);
    expect(quantitiesIn('$90.0 billion')[0].v).toBe(90e9);
  });

  it('正确换算 → 通过', () => {
    expect(ok('营收900.1亿美元，同比增长17.7%', [{ metric: 'revenue' }])).toBe(true);
    expect(ok('营收约900亿美元', [{ metric: 'revenue' }])).toBe(true);
    expect(ok('Azure收入首次超过1000亿美元，Copilot付费席位超过3000万', [{ chunk_id: 9, quote: 'Azure revenue surpassed $100 billion for the first time, and Microsoft 365 Copilot reached over 30 million paid seats' }])).toBe(true);
  });

  it('数字错、量级错、增速错 → 不通过', () => {
    expect(ok('营收910亿美元', [{ metric: 'revenue' }])).toBe(false);
    expect(ok('营收90亿美元', [{ metric: 'revenue' }])).toBe(false);
    expect(ok('营收900.1亿美元，同比增长18.7%', [{ metric: 'revenue' }])).toBe(false);
    expect(ok('Copilot付费席位超过3500万', [{ chunk_id: 9, quote: 'Microsoft 365 Copilot reached over 30 million paid seats' }])).toBe(false);
  });
});

describe('verifyClaim 相邻块回退', async () => {
  const { verifyClaim: vc } = await import('../research/verify.js');
  const a = { id: 38, ticker: 'MSFT', accession: 'k', form_type: '10-K', section: 'risk_factors', char_start: 0, char_end: 50, source_url: 'u', text: 'Competition is intense in all of our markets.' };
  const b = { id: 39, ticker: 'MSFT', accession: 'k', form_type: '10-K', section: 'risk_factors', char_start: 50, char_end: 150, source_url: 'u', text: 'Our ability to develop additional capacity is also subject to land availability and zoning restrictions.' };
  const other = { ...b, id: 37, accession: 'other-filing' };
  const base = { ticker: 'MSFT', metricsById: new Map() };
  const quote = 'Our ability to develop additional capacity is also subject to land availability';

  it('块号差一位、同一申报 → 按真实块记出处并通过', () => {
    const r = vc({ text: '扩张受土地与审批限制', evidence: [{ chunk_id: 38, quote }] }, { ...base, chunksById: new Map([[38, a]]), loadChunk: id => (id === 39 ? b : null) });
    expect(r.ok).toBe(true);
    expect(r.evidence[0]).toMatchObject({ chunk_id: 39, char_range: [50, 50 + quote.length] });
  });

  it('相邻块属于别的申报 → 不回退，不通过', () => {
    const r = vc({ text: '扩张受限', evidence: [{ chunk_id: 38, quote }] }, { ...base, chunksById: new Map([[38, a]]), loadChunk: id => (id === 37 ? other : null) });
    expect(r.ok).toBe(false);
  });
});

describe('stripCitationMarkers', async () => {
  const { stripCitationMarkers: s, verifyDraft } = await import('../research/verify.js');
  it('去掉正文里的出处标记，不动正常括号内容', () => {
    expect(s('指引营收1080亿美元±2%（chunk_id: 5062）。')).toBe('指引营收1080亿美元±2%。');
    expect(s('实际营收962.2亿美元（metric: revenue）高于指引 (chunk 5019)。')).toBe('实际营收962.2亿美元高于指引。');
    expect(s('营收增长（同比+105.9%）')).toBe('营收增长（同比+105.9%）');
  });
  it('块号不再被当成"找不到的数字"', () => {
    const chunk = { id: 5062, ticker: 'NVDA', accession: 'a', form_type: '8-K', section: 'press_release', char_start: 0, char_end: 99, source_url: 'u', text: 'Revenue is expected to be $108.0 billion, plus or minus 2%.' };
    const r = verifyDraft({ highlights: [{ text: '指引营收1080亿美元（chunk_id: 5062）', evidence: [{ chunk_id: 5062, quote: 'Revenue is expected to be $108.0 billion' }] }] },
      { ticker: 'NVDA', metricsById: new Map(), chunksById: new Map([[5062, chunk]]) });
    expect(r.report[0]).toMatchObject({ ok: true, text: '指引营收1080亿美元' });
  });
});

// 2026-10-21 deepseek 评估轮回归：年份识别不能吞掉金额；区间单位作用于两端
describe('quantitiesIn 年份与区间', async () => {
  const { quantitiesIn } = await import('../research/verify.js');
  const v = t => quantitiesIn(t).map(q => [q.v, q.pct]);
  it.each([
    ['营收2006.1亿美元', [[200.61e9, false]]],
    ['指引为1970-2020亿美元', [[197e9, false], [202e9, false]]],
    ['$61-64 billion', [[61e9, false], [64e9, false]]],
    ['在1940至1990亿美元之间', [[194e9, false], [199e9, false]]],
    ['增长16-19%', [[16, true], [19, true]]],
    ['2026年第三季度营收', []],
    ['2026-2027年产能', []],
  ])('%s', (t, want) => expect(v(t)).toEqual(want));
});

describe('verifyClaim 不许引用本季之后的申报', async () => {
  const { verifyClaim: vc } = await import('../research/verify.js');
  const later = { id: 5, ticker: 'MSFT', accession: '10k', form_type: '10-K', filing_date: '2026-07-29', section: 'risk_factors', char_start: 0, char_end: 80, source_url: 'u', text: 'Our cloud and AI strategy requires substantial investments.' };
  const ctx = { ticker: 'MSFT', metricsById: new Map(), chunksById: new Map([[5, later]]) };
  const claim = { text: '云和AI战略需要大量投资', evidence: [{ chunk_id: 5, quote: 'Our cloud and AI strategy requires substantial investments' }] };
  it('写 FY2026Q3（最后一份申报 2026-04-29）时引用 2026-07-29 的 10-K → 不通过', () => {
    expect(vc(claim, { ...ctx, asOf: '2026-04-29' }).reasons[0]).toMatch(/晚于本季最后一份申报/);
  });
  it('写 FY2026Q4 时同一块 → 通过', () => expect(vc(claim, { ...ctx, asOf: '2026-07-29' }).ok).toBe(true));
});

describe('verifyClaim 块号记错多位与表格类型名', async () => {
  const { verifyClaim: vc, quantitiesIn } = await import('../research/verify.js');
  const a = { id: 5029, ticker: 'NVDA', accession: 'q', form_type: '10-Q', section: 'mdna', char_start: 0, char_end: 30, source_url: 'u', text: 'Gaming revenue was up.' };
  const b = { id: 5019, ticker: 'NVDA', accession: 'q', form_type: '10-Q', section: 'mdna', char_start: 100, char_end: 200, source_url: 'u', text: 'We have significantly increased our supply and capacity commitments from $119 billion last quarter to $279 billion.' };
  const other = { ...b, id: 7000, accession: 'other' };
  const quote = 'increased our supply and capacity commitments from $119 billion last quarter to $279 billion';
  it('引文在本次看过的同一申报其他块里 → 通过，按真实块记出处', () => {
    const r = vc({ text: '供应承诺从$119 billion增至$279 billion', evidence: [{ chunk_id: 5029, quote }] }, { ticker: 'NVDA', metricsById: new Map(), chunksById: new Map([[5029, a], [5019, b]]) });
    expect(r.ok).toBe(true);
    expect(r.evidence[0].chunk_id).toBe(5019);
  });
  it('只在别的申报里有 → 不通过', () => {
    const r = vc({ text: '供应承诺增至$279 billion', evidence: [{ chunk_id: 5029, quote }] }, { ticker: 'NVDA', metricsById: new Map(), chunksById: new Map([[5029, a], [7000, other]]) });
    expect(r.ok).toBe(false);
  });
  it('"10-Q""8-K"不是数字', () => expect(quantitiesIn('10-Q披露，8-K公告')).toEqual([]));
});
