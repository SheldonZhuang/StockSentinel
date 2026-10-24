// QQQ N-PORT-P（2019Q3 起，季度末持仓：股数、市值、占净资产%）——用于校验 S2 的"最大权重"排序。
import { cached, edgarText, writeJSON, OUT, readJSON, DATA } from './lib.mjs';
const sub = JSON.parse(await cached('qqq_filings/submissions.json', () => edgarText('https://data.sec.gov/submissions/CIK0001067839.json')));
const f = sub.filings.recent, res = {};
for (let i = 0; i < f.form.length; i++) {
  if (f.form[i] !== 'NPORT-P') continue;
  const acc = f.accessionNumber[i].replace(/-/g, '');
  const x = await cached(`qqq_filings/nport_${f.accessionNumber[i]}.xml`, () => edgarText(`https://www.sec.gov/Archives/edgar/data/1067839/${acc}/primary_doc.xml`));
  const period = (x.match(/<repPdDate>([^<]+)</) || [])[1];
  const items = [...x.matchAll(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/g)].map(m => {
    const g = k => (m[1].match(new RegExp(`<${k}>([^<]*)<`)) || [])[1];
    return { name: g('name'), title: g('title'), cusip: g('cusip'), bal: +g('balance'), val: +g('valUSD'), pct: +g('pctVal') };
  }).filter(r => r.val > 0).sort((a, b) => b.val - a.val);
  res[period] = items.slice(0, 12).map(r => ({ ...r, filed: f.filingDate[i] }));
  console.log(period, items.length, items.slice(0, 4).map(r => `${r.name}/${r.title} ${r.pct.toFixed(2)}%`).join(' | '));
}
writeJSON(`${OUT}/qqq_nport_top.json`, res);
