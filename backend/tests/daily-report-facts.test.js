// 127号（2026-09-17）：日报 buildFacts 的货币行必须带取值来源与决议日。
//
// 为什么：这行是每天喂给 LLM 的解读依据。决议当晚利率取自 Fed 官方声明（FRED 日更序列
// 要到次一工作日才有新台阶），若日报只说"联邦基金利率4.00%"，LLM 会把它当作序列值，
// 进而给出错误的时效性判断。103号审查已确立"日报规则行与判定链必须同步"的纪律，
// 本文件是该纪律在 127 号改动上的守门人。
import { describe, it, expect } from 'vitest';
import { buildFacts } from '../api/daily-report.js';

function payload(over = {}) {
  return {
    finalSignal: 'reduce', monetarySignal: 'tight', fiscalSignal: 'neutral',
    adminSignal: 'tight', aiSupplySignal: 'loose',
    indicators: {
      rate: 4, ratePrev: 3.75, rateSource: 'fed_statement', rateDecisionDate: '2026-09-16',
      balanceSheetStatus: 'neutral', sahmValue: 0.3,
      ...over,
    },
  };
}

describe('buildFacts 货币行（127号：取值来源必须可见）', () => {
  it('Fed 声明取值时标注来源与决议日，并说明本次方向', () => {
    const facts = buildFacts(payload());
    expect(facts).toMatch(/联邦基金利率4\.00%/);
    expect(facts).toMatch(/上次决议前3\.75%/);
    expect(facts).toMatch(/本次加息/);
    expect(facts).toMatch(/取自Fed官方声明，FRED序列尚未更新/);
    expect(facts).toMatch(/决议日2026-09-16/);
  });

  it('降息方向正确标注', () => {
    expect(buildFacts(payload({ rate: 3.5, ratePrev: 3.75, rateSource: 'fred' }))).toMatch(/本次降息/);
  });

  it('按兵不动方向正确标注（利率未变）', () => {
    expect(buildFacts(payload({ rate: 3.75, ratePrev: 3.75, rateSource: 'fred' }))).toMatch(/本次按兵不动/);
  });

  it('FRED 序列取值时不加"声明"标注（避免误导）', () => {
    const facts = buildFacts(payload({ rateSource: 'fred' }));
    expect(facts).not.toMatch(/取自Fed官方声明/);
    expect(facts).toMatch(/决议日2026-09-16/);
  });

  it('旧快照缺 ratePrev / rateSource 时退化为只显示利率（不报错、不显示 undefined）', () => {
    const facts = buildFacts(payload({
      ratePrev: null, rateSource: undefined, rateDecisionDate: null,
    }));
    expect(facts).toMatch(/联邦基金利率4\.00%/);
    expect(facts).not.toMatch(/undefined/);
    expect(facts).not.toMatch(/上次决议前/);
  });

  it('保留既有字段（资产负债表/萨姆/锁标注）', () => {
    const facts = buildFacts({
      ...payload(), indicators: { ...payload().indicators, sahmLockActive: true },
    });
    expect(facts).toMatch(/资产负债表状态=neutral/);
    expect(facts).toMatch(/萨姆值0\.30/);
    expect(facts).toMatch(/萨姆锁激活/);
  });
});
