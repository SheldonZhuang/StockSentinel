// 下载 QQQ 信托（CIK 1067839）全部 485BPOS / N-30B-2 / N-CSR(S) 主文档：含 9/30 全持仓表与 12/31 前五大权重
import { cached, edgarText, writeJSON, DATA } from './lib.mjs';
const sub = JSON.parse(await cached('qqq_filings/submissions.json', () => edgarText('https://data.sec.gov/submissions/CIK0001067839.json')));
const f = sub.filings.recent, list = [];
f.form.forEach((form, i) => { if (/^(485BPOS|N-30B-2|N-CSRS?|N-30D)$/.test(form)) list.push({ form, date: f.filingDate[i], acc: f.accessionNumber[i], doc: f.primaryDocument[i] }); });
for (const it of list) {
  const rel = `qqq_filings/${it.date}_${it.form}_${it.doc}`;
  const url = `https://www.sec.gov/Archives/edgar/data/1067839/${it.acc.replace(/-/g, '')}/${it.doc}`;
  const t = await cached(rel, () => edgarText(url)); it.file = rel; it.len = t.length;
  console.log(it.form, it.date, t.length);
}
writeJSON(`${DATA}/qqq_filings/index.json`, list);
