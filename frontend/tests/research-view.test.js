// 公司研究页（129号阶段5）：公司/季度切换、关键数字表、陈述出处展开、待核对标记、七语言键齐全
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.mock('../src/api/client.js', () => ({ api: { researchNotes: vi.fn(), researchNote: vi.fn() } }));

import { api } from '../src/api/client.js';
import ResearchView from '../src/views/ResearchView.vue';
import zh from '../src/i18n/locales/zh.json';
import en from '../src/i18n/locales/en.json';
import fr from '../src/i18n/locales/fr.json';
import de from '../src/i18n/locales/de.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';

const i18n = createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'zh', messages: { zh } });
const note = {
  ticker: 'NVDA', fiscal_period: 'FY2027Q2', period_end: '2026-07-26', stage: 'final', status: 'needs_review',
  based_on: [{ accession: 'a', form: '10-Q', filing_date: '2026-08-26', url: 'https://sec.gov/a' }],
  summary: '收入同比增长105.9%。',
  key_figures: [{ id: 'revenue', label: '营业收入', unit: 'USD', value: 96221e6, prior_quarter: 81615e6, prior_year: 46743e6, qoq: 17.9, yoy: 105.9, change_unit: '%', source: { type: 'xbrl', url: 'https://sec.gov/a', concept: 'us-gaap:Revenues' } }],
  highlights: [{ text: '营收962.2亿美元', status: 'verified', evidence: [{ type: 'metric', label: '营业收入', value: '$96.22B', source: { concept: 'us-gaap:Revenues', url: 'https://sec.gov/a' } }] }],
  guidance_check: [{ text: '上季指引约$91.0B，本季$96.22B，高于指引区间上限。', status: 'verified', generated: true, evidence: [{ type: 'text', form: '8-K', section: 'press_release', char_range: [3967, 4025], quote: 'Revenue is expected to be $91.0 billion, plus or minus 2%.', url: 'https://sec.gov/b' }] }],
  changes: [],
  risks: [{ text: '供应链约束', status: 'needs_review', problems: ['引文找不到'], evidence: [] }],
  not_disclosed: [], disclaimer: '仅供研究参考',
};

function mountView() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/research', component: ResearchView }] });
  router.push('/research');
  return router.isReady().then(() => mount(ResearchView, { global: { plugins: [i18n, router] } }));
}

beforeEach(() => {
  api.researchNotes.mockReset().mockResolvedValue({ notes: [{ ticker: 'NVDA', fiscal_label: 'FY2027Q2', stage: 'final' }, { ticker: 'MSFT', fiscal_label: 'FY2026Q4', stage: 'final' }] });
  api.researchNote.mockReset().mockResolvedValue(note);
});

describe('ResearchView', () => {
  it('列出公司；默认打开第一家最新笔记；关键数字可点到 SEC', async () => {
    const w = await mountView();
    await flushPromises();
    expect(w.findAll('.tabs')[0].text()).toContain('MSFT');
    expect(api.researchNote).toHaveBeenCalledWith('NVDA', undefined);
    const link = w.find('table.figures td a');
    expect(link.text()).toBe('$96.22B');
    expect(link.attributes('href')).toBe('https://sec.gov/a');
    expect(link.attributes('rel')).toContain('noopener');
  });

  it('陈述出处可展开：原文链接、字符区间、逐字引文；程序生成与待核对有标记', async () => {
    const w = await mountView();
    await flushPromises();
    const text = w.text();
    expect(text).toContain('Revenue is expected to be $91.0 billion');
    expect(text).toContain('字符 3967–4025');
    expect(text).toContain('（程序生成）');
    expect(w.findAll('.badge.warn').length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('引文找不到');
  });

  it('切换公司重新请求', async () => {
    const w = await mountView();
    await flushPromises();
    await w.findAll('.tabs')[0].findAll('button').find(b => b.text() === 'MSFT').trigger('click');
    await flushPromises();
    expect(api.researchNote).toHaveBeenLastCalledWith('MSFT', undefined);
  });

  it('没有笔记时显示空状态', async () => {
    api.researchNotes.mockResolvedValue({ notes: [] });
    const w = await mountView();
    await flushPromises();
    expect(w.text()).toContain('暂无研究笔记');
  });

  it('七语言 research 键齐全', () => {
    const keys = o => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v).map(s => `${k}.${s}`) : [k])).sort();
    const ref = keys(zh.research);
    for (const l of [en, fr, de, es, ja, ko]) {
      expect(keys(l.research)).toEqual(ref);
      expect(l.pageTitle.research).toBeTruthy();
    }
  });
});
