// 研究文档采集面板（129号）：覆盖矩阵、问题清单（pending 不算问题）、触发按钮
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

vi.mock('../src/api/client.js', () => ({
  api: { adminResearchStatus: vi.fn(), adminResearchIngest: vi.fn() },
}));

import { api } from '../src/api/client.js';
import ResearchIngestPanel from '../src/components/ResearchIngestPanel.vue';
import zh from '../src/i18n/locales/zh.json';
import en from '../src/i18n/locales/en.json';
import fr from '../src/i18n/locales/fr.json';
import de from '../src/i18n/locales/de.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';

const i18n = createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'zh', messages: { zh } });

const status = {
  running: false,
  lastRun: { run_id: 'r1', trigger: 'backfill', started_at: '2026-10-21 06:46:29', finished_at: '2026-10-21 06:46:31', new_filings: 0, failed: 0 },
  totals: { filings: 3, parsed: 2, chunks: 120 },
  coverage: [
    { ticker: 'MSFT', fiscal_year: 2026, fiscal_quarter: 4, doc_kind: 'annual', form_type: '10-K', status: 'parsed', accession: 'a1', chunk_count: 100 },
    { ticker: 'MSFT', fiscal_year: 2026, fiscal_quarter: 4, doc_kind: 'earnings_release', form_type: '8-K', status: 'parsed', accession: 'a2', chunk_count: 20 },
    { ticker: 'MSFT', fiscal_year: 2026, fiscal_quarter: 3, doc_kind: 'periodic', form_type: '10-Q', status: 'failed', accession: 'a3', chunk_count: null },
  ],
  wiki: [{ ticker: 'MSFT', filings: 14, done: 13, blocked: 1, entries: 40, conflicts: 2 }],
  budget: { researchToday: 0.01, researchMonth: 0.2, askMonth: 0, backfillTotal: 0.5, budgets: { research: { daily: 0.5, monthly: 5 }, ask: { monthly: 3 }, backfill: { total: 3 }, eval: { perRun: 12 } } },
  issues: [
    { ticker: 'MSFT', kind: 'pending_quarter', detail: 'FY2027Q1 periodic' },
    { ticker: 'MSFT', kind: 'missing_quarter', detail: 'FY2026Q3 periodic (failed: 404)' },
  ],
};

describe('ResearchIngestPanel', () => {
  beforeEach(() => {
    api.adminResearchStatus.mockReset().mockResolvedValue(structuredClone(status));
    api.adminResearchIngest.mockReset().mockResolvedValue({ started: true });
  });

  it('覆盖矩阵：每季显示已解析文件缩写，失败季标红', async () => {
    const w = mount(ResearchIngestPanel, { global: { plugins: [i18n] } });
    await flushPromises();
    const cells = w.findAll('tbody tr')[0].findAll('td');
    expect(cells).toHaveLength(8);
    expect(cells[0].text()).toBe('2026Q4 EK');
    expect(cells[1].classes()).toContain('bad');
    expect(cells[7].text()).toBe('—');
    expect(w.text()).toContain('已解析 2 份申报 / 120 个块');
    expect(w.text()).toContain('本月 $0.20 / 5');
    expect(w.text()).toContain('首次回填累计 $0.50 / 3');
    expect(w.text()).toContain('13 / 14');
  });

  it('pending 不算问题，只计数', async () => {
    const w = mount(ResearchIngestPanel, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(w.text()).toContain('数据质量问题（1）');
    expect(w.text()).toContain('缺季');
    expect(w.text()).toContain('另有 1 项未到法定申报期限');
  });

  it('点击触发增量采集', async () => {
    const w = mount(ResearchIngestPanel, { global: { plugins: [i18n] } });
    await flushPromises();
    await w.find('button').trigger('click');
    expect(api.adminResearchIngest).toHaveBeenCalledTimes(1);
    expect(w.find('button').attributes('disabled')).toBeDefined();
  });

  it('七语言 admin.research 键齐全', () => {
    const keys = o => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v).map(s => `${k}.${s}`) : [k])).sort();
    const ref = keys(zh.admin.research);
    for (const l of [en, fr, de, es, ja, ko]) expect(keys(l.admin.research)).toEqual(ref);
  });
});
