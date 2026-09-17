// 127号（2026-09-17）：Fed 官方声明源单测。
// 真实事故：2026-09-16 加息 25bp 至 3.75-4.00%，当晚快照的 FRED 值仍是决议前的 3.75，
// 判定链得出 currentRate=prevRate=3.75 → 「暂停→宽松」→ 货币维 loose（方向完全反了），
// 网页显示「3.75% 0.00%（持平）」。本模块把 Fed 自己的新闻稿作为决议结果的即时权威源。
//
// 测试数据来自 2026-09-16 / 2026-07-29 / 2026-06-17 三份真实声明页的正文句（已实测抓取），
// 保证正则与 Fed 实际措辞一致——Fed 换代或改措辞时本测试是最先报警的地方。
import { describe, it, expect } from 'vitest';
import {
  parseFractionPercent, nextBusinessDay, etDateOf, htmlToText, parseFomcStatement,
  fetchLatestFedDecision,
} from '../api/fetch-fed-rate.js';
import { applyFedDecisionOverride } from '../api/fetch-macro.js';
import { deriveSubSignals } from '../api/signal.js';

describe('parseFractionPercent（Fed 的英文分数写法）', () => {
  it('整数与分数写法', () => {
    expect(parseFractionPercent('4')).toBe(4);
    expect(parseFractionPercent('3-3/4')).toBe(3.75);
    expect(parseFractionPercent('3-1/2')).toBe(3.5);
    expect(parseFractionPercent('0-1/4')).toBe(0.25);
    expect(parseFractionPercent('5-1/4')).toBe(5.25);
  });
  it('非法输入返回 null', () => {
    expect(parseFractionPercent(null)).toBeNull();
    expect(parseFractionPercent('abc')).toBeNull();
    expect(parseFractionPercent('3-3/0')).toBeNull();
  });
});

describe('nextBusinessDay（台阶生效日=决议次一工作日）', () => {
  it('周三决议 → 周四生效', () => {
    expect(nextBusinessDay('2026-09-16')).toBe('2026-09-17');
  });
  it('周五决议 → 周一', () => {
    expect(nextBusinessDay('2026-01-30')).toBe('2026-02-02');
  });
});

describe('etDateOf（RSS pubDate → 美东日历日）', () => {
  // 关键回归：Fed 的 pubDate 是 18:00 GMT = 14:00 ET。不能用 en-CA locale
  // （本机 Node 25 下 en-CA 输出 '9/16/2026' 而非 ISO，会让日期比较全部失真），故手动拼装
  it('18:00 UTC 映射到当日 ET', () => {
    expect(etDateOf('Wed, 16 Sep 2026 18:00:00 GMT')).toBe('2026-09-16');
  });
  it('晚于 ET 午夜的 UTC 时刻归属前一日', () => {
    expect(etDateOf('Thu, 17 Sep 2026 02:00:00 GMT')).toBe('2026-09-16');
  });
  it('非法输入返回 null', () => {
    expect(etDateOf('not a date')).toBeNull();
  });
});

describe('parseFomcStatement（解析真实声明措辞）', () => {
  // 2026-09-16 加息的真实句子（含 "by 1/4 percentage point" 分数幅度写法）
  const RAISE_2026_09_16 = `The Committee decided to raise the target range for the federal
    funds rate by 1/4 percentage point to 3-3/4 to 4 percent, in support of the Federal Reserve's
    dual mandate.`;
  // 2026-07-29 按兵不动的真实句子
  const HOLD_2026_07_29 = `The Committee decided to maintain the target range for the federal
    funds rate at 3-1/2 to 3-3/4 percent, in support of the Federal Reserve's dual mandate.`;

  it('解析加息（含分数幅度措辞）', () => {
    const r = parseFomcStatement(RAISE_2026_09_16, '2026-09-16');
    expect(r).not.toBeNull();
    expect(r.action).toBe('raise');
    expect(r.lower).toBe(3.75);
    expect(r.upper).toBe(4);
    expect(r.decisionDate).toBe('2026-09-16');
    expect(r.effectiveDate).toBe('2026-09-17');
    expect(r.rangeWidthBp).toBe(25);
  });

  it('解析按兵不动', () => {
    const r = parseFomcStatement(HOLD_2026_07_29, '2026-07-29');
    expect(r.action).toBe('maintain');
    expect(r.lower).toBe(3.5);
    expect(r.upper).toBe(3.75);
    expect(r.effectiveDate).toBe('2026-07-29'); // 按兵不动无台阶，生效日=决议日
  });

  it('解析降息', () => {
    const r = parseFomcStatement(
      'The Committee decided to lower the target range for the federal funds rate by 1/2 percentage point to 3 to 3-1/4 percent.',
      '2026-10-28');
    expect(r.action).toBe('lower');
    expect(r.lower).toBe(3);
    expect(r.upper).toBe(3.25);
  });

  it('HTML 包裹与实体也能解析（真实页面形态）', () => {
    const html = `<html><body><div><p>The Committee <b>decided to raise</b> the target range
      for the federal&nbsp;funds rate by 1/4 percentage point to 3&#45;3/4 to 4 percent, in support.</p>
      <script>var x = "decided to lower the target range for the federal funds rate to 0 to 0-1/4 percent";</script>
      </div></body></html>`;
    const r = parseFomcStatement(html, '2026-09-16');
    expect(r).not.toBeNull();
    expect(r.action).toBe('raise'); // script 内文本必须被剥离，不得命中
    expect(r.upper).toBe(4);
  });

  it('措辞改版/无声明 → null（退回 FRED 逻辑，不抛错）', () => {
    expect(parseFomcStatement('The Committee had a nice lunch.', '2026-09-16')).toBeNull();
    expect(parseFomcStatement('', '2026-09-16')).toBeNull();
    expect(parseFomcStatement(null, '2026-09-16')).toBeNull();
  });

  it('区间倒置 → null（解析错位时拒绝出数）', () => {
    expect(parseFomcStatement(
      'decided to maintain the target range for the federal funds rate at 4 to 3-3/4 percent', '2026-09-16')).toBeNull();
  });
});

describe('htmlToText（实体与标签处理）', () => {
  it('剥离 script/style，还原 nbsp 与数字实体', () => {
    const t = htmlToText('<p>a&nbsp;b</p><style>x{}</style><script>y</script><p>3&#45;3/4</p>');
    expect(t).toContain('a b');
    expect(t).toContain('3-3/4');
    expect(t).not.toContain('y');
    expect(t).not.toContain('x{}');
  });
});

describe('fetchLatestFedDecision（RSS 挑选与降级）', () => {
  const items = [
    { title: 'Federal Reserve issues FOMC statement', date: '2026-09-16',
      link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm' },
    // 同日发布的预测摘要（b.htm）不得被误取为决议
    { title: 'Federal Reserve Board and Federal Open Market Committee release economic projections',
      date: '2026-09-16',
      link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916b.htm' },
    { title: 'Minutes of the Federal Open Market Committee, July 28-29, 2026', date: '2026-08-19',
      link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260819a.htm' },
  ];
  const stmtHtml = 'The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.';

  it('选中声明条目并解析（跳过预测摘要与纪要）', async () => {
    const r = await fetchLatestFedDecision({
      items, today: '2026-09-17', windowDays: 10, fetchHtml: async () => stmtHtml,
    });
    expect(r.action).toBe('raise');
    expect(r.link).toContain('monetary20260916a.htm');
  });

  it('窗口外的旧声明不取', async () => {
    const r = await fetchLatestFedDecision({
      items, today: '2026-09-17', windowDays: 0, fetchHtml: async () => stmtHtml,
    });
    expect(r).toBeNull();
  });

  it('未来声明不取（RSS 时钟偏差防护）', async () => {
    const r = await fetchLatestFedDecision({
      items, today: '2026-09-10', windowDays: 10, fetchHtml: async () => stmtHtml,
    });
    expect(r).toBeNull();
  });

  it('抓取失败 → null（不抛错）', async () => {
    const r = await fetchLatestFedDecision({
      items, today: '2026-09-17', windowDays: 10,
      fetchHtml: async () => { throw new Error('network down'); },
    });
    expect(r).toBeNull();
  });
});

// --- applyFedDecisionOverride：Fed 声明 → 判定链输入（127号核心） ---
// 这是"网页显示正确方向"的关键一步：把声明区间换算出 currentRate/prevRate/合成台阶，
// 使 deriveSubSignals 判出 tight（而非 FRED 滞后造成的 loose/持平）。
describe('applyFedDecisionOverride（决议当晚用 Fed 声明顶替未更新的 FRED）', () => {
  const RAISE = {
    action: 'raise', lower: 3.75, upper: 4,
    decisionDate: '2026-09-16', effectiveDate: '2026-09-17', rangeWidthBp: 25,
  };
  // 2026-09-16 实况：FRED 现值与决议前水平都还是 3.75
  const FRED_STALE = {
    currentRate: 3.75, prevRate: 3.75,
    rateSteps: [{ date: '2026-07-30', diffBp: -25 }],
  };

  it('加息当晚：顶替为 4.00/3.75 → 方向 tight，并注入合成台阶', () => {
    const o = applyFedDecisionOverride({
      macroData: FRED_STALE, fedDecision: RAISE, today: '2026-09-16',
    });
    expect(o).not.toBeNull();
    expect(o.currentRate).toBe(4);
    expect(o.prevRate).toBe(3.75);
    expect(Math.round((o.currentRate - o.prevRate) * 100)).toBe(25); // 方向=tight
    expect(o.stepBp).toBe(25);
    expect(o.rateSource).toBe('fed_statement');
    // 合成台阶排在序列台阶之前，生效日=决议次一工作日（锁状态机据此判幅度）
    expect(o.rateSteps[0]).toEqual({ date: '2026-09-17', diffBp: 25, source: 'fed_statement' });
    expect(o.rateSteps[1].date).toBe('2026-07-30');
  });

  it('50bp 应对式加息同样按数值推幅度（不按措辞猜 25bp）', () => {
    const o = applyFedDecisionOverride({
      macroData: FRED_STALE,
      fedDecision: { action: 'raise', lower: 4, upper: 4.5, decisionDate: '2026-09-16', effectiveDate: '2026-09-17' },
      today: '2026-09-16',
    });
    expect(o.stepBp).toBe(75); // 旧上限 3.75 → 新上限 4.50
    expect(Math.round((o.currentRate - o.prevRate) * 100)).toBe(75); // prevRate 与幅度同源一致
  });

  it('降息：方向为负', () => {
    const o = applyFedDecisionOverride({
      macroData: { currentRate: 4, prevRate: 4, rateSteps: [] },
      fedDecision: { action: 'lower', lower: 3.5, upper: 3.75, decisionDate: '2026-10-28', effectiveDate: '2026-10-29' },
      today: '2026-10-28',
    });
    expect(Math.round((o.currentRate - o.prevRate) * 100)).toBe(-25);
    expect(o.rateSteps[0].diffBp).toBe(-25);
  });

  it('FRED 已收录台阶 → 不做顶替（自动退回序列口径，无跳变）', () => {
    expect(applyFedDecisionOverride({
      macroData: { ...FRED_STALE, rateSteps: [{ date: '2026-09-17', diffBp: 25 }] },
      fedDecision: RAISE, today: '2026-09-17',
    })).toBeNull();
  });

  it('按兵不动且 FRED 有值 → 不顶替（序列口径本就是"暂停"）', () => {
    expect(applyFedDecisionOverride({
      macroData: FRED_STALE,
      fedDecision: { action: 'maintain', lower: 3.5, upper: 3.75, decisionDate: '2026-07-29', effectiveDate: '2026-07-29' },
      today: '2026-07-29',
    })).toBeNull();
  });

  it('按兵不动但 FRED 现值缺失 → 用声明区间兜底（避免货币维静默转 neutral）', () => {
    const o = applyFedDecisionOverride({
      macroData: { currentRate: null, prevRate: null, rateSteps: [] },
      fedDecision: { action: 'maintain', lower: 3.5, upper: 3.75, decisionDate: '2026-07-29', effectiveDate: '2026-07-29' },
      today: '2026-07-29',
    });
    expect(o.currentRate).toBe(3.75);
    expect(o.prevRate).toBe(3.75);
    expect(o.stepBp).toBe(0);
  });

  it('未来声明的决议日不顶替（绝不提前计入）', () => {
    expect(applyFedDecisionOverride({
      macroData: FRED_STALE,
      fedDecision: { ...RAISE, decisionDate: '2026-10-28', effectiveDate: '2026-10-29' },
      today: '2026-09-16',
    })).toBeNull();
  });

  it('无声明（源不可用/解析失败）→ null，判定链退回纯 FRED 逻辑', () => {
    expect(applyFedDecisionOverride({
      macroData: FRED_STALE, fedDecision: null, today: '2026-09-16',
    })).toBeNull();
  });

  it('与 deriveSubSignals 联用：顶替后货币方向为 tight（真实事故的回归断言）', () => {
    const o = applyFedDecisionOverride({
      macroData: FRED_STALE, fedDecision: RAISE, today: '2026-09-16',
    });
    // 修复前：currentRate=prevRate=3.75 → 'loose'（方向反了）；修复后必须为 'tight'
    expect(deriveSubSignals({
      currentRate: o.currentRate, prevRate: o.prevRate,
      currentBalanceSheet: null, prevBalanceSheet: null,
    }).rateSignal).toBe('tight');
  });
});
