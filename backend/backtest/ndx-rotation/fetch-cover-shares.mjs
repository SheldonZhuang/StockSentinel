// 2009 年前没有 XBRL：从 10-K/10-Q 封面抓 "shares ... outstanding" 股数（1999-01 ~ 2010-06），只覆盖可能成为市值第一的公司。
// 解析规则：剥标签后取文档前 30k 字符，找 "outstanding" 附近 ±400 字符内、前面不带 $ 的 ≥1 亿整数；多个取第一个。逐条打印供人工复核。
import { cached, edgarText, writeJSON, OUT } from './lib.mjs';
const COS = { MSFT: 789019, CSCO: 858877, INTC: 50863, ORCL: 777676, AAPL: 320193, GOOG: 1288776, QCOM: 804328, AMGN: 318154 };
const res = {};
for (const [tk, cik] of Object.entries(COS)) {
  const id = String(cik).padStart(10, '0');
  const sub = JSON.parse(await cached(`edgar/sub_${id}.json`, () => edgarText(`https://data.sec.gov/submissions/CIK${id}.json`)));
  const pages = [sub.filings.recent];
  for (const f of sub.filings.files || []) pages.push(JSON.parse(await cached(`edgar/${f.name}`, () => edgarText(`https://data.sec.gov/submissions/${f.name}`))));
  const list = [];
  for (const p of pages) p.form.forEach((form, i) => { if (/^10-[KQ](405)?$/.test(form) && p.filingDate[i] >= '1999-01-01' && p.filingDate[i] <= '2010-08-01') list.push({ form, filed: p.filingDate[i], acc: p.accessionNumber[i], doc: p.primaryDocument[i] }); });
  res[tk] = [];
  for (const it of list.sort((a, b) => a.filed.localeCompare(b.filed))) {
    const url = it.doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${it.acc.replace(/-/g, '')}/${it.doc}` : `https://www.sec.gov/Archives/edgar/data/${cik}/${it.acc}.txt`;
    let raw;
    const full = `https://www.sec.gov/Archives/edgar/data/${cik}/${it.acc}.txt`; // 主文档 404 时回退到完整提交文本
    try { raw = await cached(`edgar/cover/${tk}_${it.filed}_${it.form}.txt`, async () => { try { return (await edgarText(url)).slice(0, 120000); } catch (e) { if (e?.response?.status !== 404) throw e; return (await edgarText(full)).slice(0, 120000); } }); }
    catch (e) { console.log(tk, it.filed, 'fetch fail', e?.response?.status); continue; }
    const t = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&#8217;|&#146;/g, "'").replace(/\s+/g, ' ').slice(0, 30000);
    let val = null;
    if (tk === 'GOOG') {
      const A = t.match(/Class A common stock[^0-9]{0,40}([0-9]{2,3}(?:,[0-9]{3}){2})/i), B = t.match(/Class B common stock[^0-9]{0,40}([0-9]{2,3}(?:,[0-9]{3}){2})/i);
      if (A) val = +A[1].replace(/,/g, ''); // 指数只含上市的 A 类（2014 年拆出 C 类前）
    } else {
      // 封面股数：离第一个 'outstanding' 最近、前面不带 $ 的大整数（排除 10-K 封面的非关联方市值 $xxx）；Intel 用 'x,xxx million'
      const w0 = t.search(/outstanding/i);
      if (w0 >= 0) {
        const win = t.slice(Math.max(0, w0 - 300), w0 + 300), c = 300;
        const cands = [...win.matchAll(/([0-9]{1,3}(?:,[0-9]{3}){2,})/g)]
          .filter(n => !/\$\s*$/.test(win.slice(Math.max(0, n.index - 3), n.index)))
          .map(n => ({ v: +n[1].replace(/,/g, ''), dist: Math.abs(n.index - c) })).filter(n => n.v >= 1e7 && n.v < 5e10)
          .sort((x, y) => x.dist - y.dist);
        const mil = win.match(/([0-9]{1,3},[0-9]{3})\s*million/i);
        if (cands.length) val = cands[0].v; else if (mil) val = +mil[1].replace(/,/g, '') * 1e6;
      }
    }
    res[tk].push({ filed: it.filed, form: it.form, val });
    console.log(tk, it.filed, it.form, val, val ? '' : 'NOT FOUND');
  }
}
writeJSON(`${OUT}/shares_cover.json`, res);
