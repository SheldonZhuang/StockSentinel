// 研究 Agent 阶段1（129号）：HTML→文本、章节切分、切块的纯函数测试。
// 夹具模拟真实申报里踩到的结构：目录(TOC)、MSFT 式翻页页眉、AMZN 式表格标题、20-F 附件后的 F 页
import { describe, it, expect } from 'vitest';
import { htmlToText, splitSections, chunkSection, tagTopics } from '../research/parse.js';

const para = (s, n) => Array.from({ length: n }, (_, i) => `${s} sentence ${i}. More words here to fill the paragraph.`).join(' ');

describe('htmlToText', () => {
  it('去掉 ix:header/script/style，块级断行，单元格用 | 分隔，实体解码', () => {
    const html = `<html><head><title>x</title></head><body>
      <ix:header><ix:hidden>HIDDEN</ix:hidden></ix:header><script>var a=1</script>
      <p>Revenue&#160;was&nbsp;$77.7&#160;billion &amp; grew</p>
      <table><tr><td>Azure</td><td>40%</td></tr></table>
      <div>Microsoft&#8217;s cloud</div></body></html>`;
    const t = htmlToText(html);
    expect(t).not.toMatch(/HIDDEN|var a/);
    expect(t).toContain('Revenue was $77.7 billion & grew');
    expect(t).toContain('Azure | 40%');
    expect(t).toContain("Microsoft's cloud");
    expect(t).not.toMatch(/\n\n/);
  });

  it('同一输入结果逐字节一致（char_range 可复现的前提）', () => {
    const html = '<p>a</p><p>b&#8220;c&#8221;</p>';
    expect(htmlToText(html)).toBe(htmlToText(html));
  });
});

describe('splitSections', () => {
  const tenQ = [
    'PART I. FINANCIAL INFORMATION',
    'Item 1. Financial Statements', 'Item 2. Management\'s Discussion and Analysis', // 目录
    'PART II. OTHER INFORMATION', 'Item 1A. Risk Factors', 'Item 6. Exhibits',
    'Forward-looking preamble that must not be swallowed by the TOC.',
    'PART I',
    'ITEM 1. FINANCIAL STATEMENTS', para('Balance', 10),
    'PART I', 'Item 1', 'NOTES TO FINANCIAL STATEMENTS', para('Note', 10), // 翻页页眉
    'ITEM 2. MANAGEMENT\'S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION', para('Revenue', 10),
    'PART II',
    'ITEM 1A. RISK FACTORS', para('Risk', 10),
    'ITEM 6. EXHIBITS', 'Exhibit list',
  ].join('\n');

  it('跳过目录，正文从第二次出现的首个 Item 开始；页眉不另起章节', () => {
    const secs = splitSections(tenQ, '10-Q');
    const names = secs.map(s => s.section);
    expect(names).toEqual(['financial_statements', 'mdna', 'risk_factors', 'exhibits']);
    const fs = secs[0];
    expect(tenQ.slice(fs.start, fs.end)).toContain('NOTES TO FINANCIAL STATEMENTS'); // 页眉并入
    expect(tenQ.slice(0, fs.start)).toContain('Forward-looking preamble');
    expect(secs.every(s => !tenQ.slice(s.start, s.end).includes('Forward-looking preamble'))).toBe(true);
  });

  it('AMZN 表格式标题 "Item 1. | Business"', () => {
    const t = ['Item 1. | Business', 'Item 1A. | Risk Factors', 'Item 1. | Business', para('Biz', 10), 'Item 1A. | Risk Factors', para('Risk', 10)].join('\n');
    expect(splitSections(t, '10-K').map(s => s.section)).toEqual(['business', 'risk_factors']);
  });

  it('标题另起一行（"Item 1A." 下一行是标题）', () => {
    const t = ['Item 1A.', 'Risk Factors', 'Item 1A.', 'Risk Factors', para('Risk', 10)].join('\n');
    expect(splitSections(t, '10-K')[0].section).toBe('risk_factors');
  });

  it('20-F：Exhibits 之后的审计报告起切出 F 页财报', () => {
    const t = ['ITEM 3. KEY INFORMATION', 'ITEM 19. EXHIBITS', // 目录
      'ITEM 3. KEY INFORMATION', para('Risk', 10),
      'ITEM 5. OPERATING AND FINANCIAL REVIEWS AND PROSPECTS', para('Ops', 10),
      'ITEM 19. EXHIBITS', 'Exhibit index',
      'REPORT OF INDEPENDENT REGISTERED PUBLIC ACCOUNTING FIRM', para('Consolidated', 10)].join('\n');
    const secs = splitSections(t, '20-F');
    expect(secs.map(s => s.section)).toEqual(['risk_factors', 'mdna', 'exhibits', 'financial_statements']);
    const f = secs.at(-1);
    expect(t.slice(f.start, f.end)).toMatch(/^REPORT OF INDEPENDENT/);
  });

  it('新闻稿（8-K / 6-K）整篇一个 press_release 章节', () => {
    expect(splitSections('Company reports results', '8-K')).toEqual([
      { section: 'press_release', item: null, title: null, start: 0, end: 23 },
    ]);
    expect(splitSections('', '6-K')).toEqual([]);
  });
});

describe('chunkSection', () => {
  const text = ['intro', ...Array.from({ length: 30 }, (_, i) => para(`P${i}`, 4)), 'tail'].join('\n');
  const sec = { section: 'mdna', start: 6, end: text.length - 5 };

  it('块在章节内、互不重叠、不超上限，slice 即块正文', () => {
    const chunks = chunkSection(text, sec, { target: 1000, max: 1500 });
    expect(chunks.length).toBeGreaterThan(3);
    let prevEnd = sec.start;
    for (const c of chunks) {
      expect(c.start).toBeGreaterThanOrEqual(prevEnd);
      expect(c.end).toBeLessThanOrEqual(sec.end);
      expect(c.end - c.start).toBeLessThanOrEqual(1500);
      expect(text[c.start]).toMatch(/\S/);
      expect(text[c.end - 1]).toMatch(/\S/);
      prevEnd = c.end;
    }
    expect(chunks.map((c, i) => c.seq === i && c.section === 'mdna').every(Boolean)).toBe(true);
  });

  it('覆盖完整：所有非空白字符都落在某个块里', () => {
    const chunks = chunkSection(text, sec, { target: 1000, max: 1500 });
    const covered = chunks.reduce((n, c) => n + text.slice(c.start, c.end).replace(/\s/g, '').length, 0);
    expect(covered).toBe(text.slice(sec.start, sec.end).replace(/\s/g, '').length);
  });

  it('单段超长按句末硬切', () => {
    const long = para('Long', 200); // 单段远超 max
    const chunks = chunkSection(long, { section: 'x', start: 0, end: long.length }, { target: 1000, max: 1500 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every(c => c.end - c.start <= 1500)).toBe(true);
    expect(chunks.slice(0, -1).every(c => long[c.end - 1] === '.')).toBe(true);
  });
});

describe('tagTopics', () => {
  it('分部收入 / 资本开支 / 指引', () => {
    expect(tagTopics('Intelligent Cloud segment revenue increased 28%')).toContain('segment_revenue');
    expect(tagTopics('Purchases of property and equipment were $35.8 billion')).toContain('capex');
    expect(tagTopics('For the fourth quarter of fiscal 2027, we expect revenue to be $54.0 billion')).toContain('guidance');
    expect(tagTopics('The board declared a dividend')).toEqual([]);
  });
});
