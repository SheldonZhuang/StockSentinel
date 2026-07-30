// 对外数字单一来源化守卫（116号建议3，2026-07-30 用户拍板采纳）：
// SKILL.md / docs/backtest-report.md 里对外引用的回测数字必须与引擎产物
// （backtest-raw.json / daily-replay-raw.json / bootstrap-ci.json）一致——
// 数字漂移直接让测试失败，而不是等下一轮人工审查发现（本轮就修了一批漂移 11 天的数字）。
// 重跑回测/自助脚本后若本测试失败，说明该同步文档数字了（这正是测试的目的）。
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const monthly = JSON.parse(fs.readFileSync(path.join(root, 'backtest/backtest-raw.json'), 'utf8')).summary;
const daily = JSON.parse(fs.readFileSync(path.join(root, 'backtest/daily-replay-raw.json'), 'utf8')).overall.daily;
const ci = JSON.parse(fs.readFileSync(path.join(root, 'backtest/bootstrap-ci.json'), 'utf8'));
// 文档用 Unicode 减号（−）排版，数字比较前统一归一为 ASCII
const norm = s => s.replace(/−/g, '-');
const skill = norm(fs.readFileSync(path.join(root, '../skills/stock-sentinel/SKILL.md'), 'utf8'));
const report = norm(fs.readFileSync(path.join(root, '../docs/backtest-report.md'), 'utf8'));

const f1 = v => v.toFixed(1); // 一位小数口径

describe('SKILL.md 对外数字与引擎产物一致', () => {
  it('月度年化/买持年化', () => {
    expect(skill).toContain(`策略年化约${f1(monthly.overall.stratCagr)}%`);
    expect(skill).toContain(`买入持有约${f1(monthly.overall.buyHoldCagr)}%`);
  });
  it('日度年化', () => {
    expect(skill).toContain(`年化约${f1(daily.cagrPct)}%`);
  });
  it('防守期月均', () => {
    expect(skill).toContain(`防守期月均约${f1(monthly.avgDefenseRet)}%`);
  });
  it('reduce 减半仓对照', () => {
    expect(skill).toContain(`${f1(monthly.overall.reduceHalfCagr)}% vs 不动 ${f1(monthly.overall.stratCagr)}%`);
  });
  it('块自助 90% 区间（年化差）', () => {
    const d = ci.ci90.diffPp;
    expect(skill).toContain(`[${d.p5}, +${d.p95}]pp`);
    expect(skill).toContain(`约${Math.round(ci.probDiffPositive * 100)}%`);
  });
});

describe('docs/backtest-report.md 汇总数字与引擎产物一致', () => {
  it('全期年化与回撤', () => {
    expect(report).toContain(`年化 ${f1(monthly.overall.stratCagr)}%、最大回撤 ${f1(monthly.overall.stratMdd)}%`);
    expect(report).toContain(`年化 ${f1(monthly.overall.buyHoldCagr)}%、最大回撤 ${f1(monthly.overall.buyHoldMdd)}%`);
  });
  it('自助区间行与 bootstrap-ci.json 一致', () => {
    const d = ci.ci90.diffPp;
    expect(report).toContain(`年化差 [${d.p5}pp, +${d.p95}pp]`);
  });
});
