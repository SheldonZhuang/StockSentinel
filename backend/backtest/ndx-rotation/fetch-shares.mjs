// S2 候选公司的流通股数：SEC companyconcept dei:EntityCommonStockSharesOutstanding（10-K/10-Q 封面股数，2009 年起有 XBRL）。
// 时点规则：取 filed <= 参考日 的最新一条（无前视）。多类别公司（Alphabet/Meta）封面按类别带维度披露，companyconcept 里没有 → 单独处理。
import { cached, edgarText, writeJSON, OUT } from './lib.mjs';
export const CIKS = { AAPL: [320193], MSFT: [789019], CSCO: [858877], INTC: [50863], QCOM: [804328], ORCL: [1341439, 777676],
  AMZN: [1018724], NVDA: [1045810], AVGO: [1730168, 1649338, 1441634], TSLA: [1318605], GOOGL: [1652044, 1288776], META: [1326801],
  DELL: [826083], EBAY: [1065088], AMGN: [318154] };
const out = {};
for (const [tk, ciks] of Object.entries(CIKS)) {
  const pts = [];
  for (const cik of ciks) {
    const id = String(cik).padStart(10, '0');
    let j;
    try { j = JSON.parse(await cached(`edgar/concept_${id}_dei_shares.json`, () => edgarText(`https://data.sec.gov/api/xbrl/companyconcept/CIK${id}/dei/EntityCommonStockSharesOutstanding.json`))); }
    catch (e) { console.log(tk, cik, 'no concept', e?.response?.status || e.message); continue; }
    const arr = j?.units?.shares;
    if (!Array.isArray(arr)) { console.log(tk, cik, 'units.shares not array'); continue; } // 119号教训：空对象陷阱
    for (const f of arr) pts.push({ end: f.end, filed: f.filed, val: f.val, form: f.form, cik });
  }
  pts.sort((a, b) => a.filed.localeCompare(b.filed) || a.end.localeCompare(b.end));
  out[tk] = pts;
  console.log(tk, pts.length, pts[0]?.filed, pts.at(-1)?.filed, pts.at(-1)?.val);
}
writeJSON(`${OUT}/shares_dei.json`, out);
