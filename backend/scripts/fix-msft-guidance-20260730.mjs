// 一次性修正脚本（2026-07-30）：MSFT FY26Q4 指引记录为财报前预览文章污染，
// 用财报后多源核实数据覆盖。运行前须停掉 server.js（sql.js 内存库会覆盖文件写入）。
import initSqlJs from 'sql.js';
import fs from 'fs';

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('data/stock-sentinel.db'));

const quote = "CFO Amy Hood: calendar 2026 investment plans unchanged; extending useful life of datacenter/office buildings from 15 to 25 years (and shifting more future datacenter leases to operating leases) restates CY2026 capex+finance leases to ~$175B, comparable to the prior ~$190B — no change in actual spending. Q4 capex+finance leases $41B (+70% YoY), cash PP&E $35.8B. FY27 Q1 capex expected to exceed $50B; FY27 capex to grow YoY.";
const fy = "CY2026 ~$175B capex+finance leases (restated from ~$190B by useful-life accounting change 15y->25y; actual spending unchanged)";
const fwd = "FY2027 Q1 capex >$50B; FY2027 capex expected to grow YoY on demand exceeding capacity";
const sources = JSON.stringify([
  "https://www.cnbc.com/2026/07/29/microsoft-msft-q4-earnings-report-2026.html",
  "https://www.theregister.com/software/2026/07/30/microsoft-earnings-q4-26-cloud-brings-revenue-rain/5280798",
  "https://www.zerohedge.com/markets/msft-bounces-after-revenue-beat-cloud-strength-capex-line",
  "https://convergedigest.com/microsoft-plans-175-billion-in-2026-capital-spending/",
]);

db.run(
  `UPDATE capex_guidance_records SET
     direction = 'maintain', quote = ?, confidence = 'high',
     fy_guidance = ?, forward_guidance = ?, sources = ?
   WHERE symbol = 'MSFT' AND accession = '0001193125-26-323632'`,
  [quote, fy, fwd, sources]
);

const chk = db.exec("SELECT symbol, direction, fy_guidance FROM capex_guidance_records WHERE symbol='MSFT'");
console.log(JSON.stringify(chk[0].values, null, 1));

const data = db.export();
fs.writeFileSync('data/stock-sentinel.db.tmp', Buffer.from(data));
fs.renameSync('data/stock-sentinel.db.tmp', 'data/stock-sentinel.db');
console.log('DB persisted');
