// 申报发现与分类（129号，纯函数为主）：submissions JSON → 研究所需的申报清单（含财季归属）。
// 财季口径：一律"财年 + 财季 + 报告期末"三件套标识（MSFT 财年 6 月结束、NVDA 1 月结束，
// 自然季度会让 API 参数含义不清）。52/53 周财年（NVDA/AMD/AVGO）期末日每年漂移几天，按容差归属。

const DAY = 86400000;
const ms = d => Date.parse(`${d}T00:00:00Z`);
const iso = t => new Date(t).toISOString().slice(0, 10);
const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/**
 * 报告期末 → 财年/财季。fye 为 submissions.fiscalYearEnd（'MMDD'）。
 * 财年 = 该期末之后（含 10 天容差）最近一个财年结束日所在年份；财季 = 4 − round(距财年结束月数 / 3)。
 */
export function fiscalPeriodFor(periodEnd, fye) {
  const p = ms(periodEnd);
  const mm = Number(fye.slice(0, 2));
  const dd = Number(fye.slice(2));
  const y = new Date(p).getUTCFullYear();
  let fyEnd = Date.UTC(y, mm - 1, Math.min(dd, daysInMonth(y, mm - 1)));
  if (fyEnd < p - 10 * DAY) fyEnd = Date.UTC(y + 1, mm - 1, Math.min(dd, daysInMonth(y + 1, mm - 1)));
  const months = (fyEnd - p) / (30.4375 * DAY);
  const q = 4 - Math.round(months / 3);
  return { fiscalYear: new Date(fyEnd).getUTCFullYear(), fiscalQuarter: Math.min(4, Math.max(1, q)) };
}

/** 'FY2026Q1' 标签（笔记与 API 的季度参数统一用这个） */
export const fiscalLabel = (fy, fq) => `FY${fy}Q${fq}`;

/**
 * 名义季末日序列（降序），截止 asOf（含）。财年结束日为月末的（MSFT 0630、NVDA 0131）季末取月末；
 * 否则取同日（AMD 1226 → 9/26、6/26…；实际 52/53 周期末与名义差几天，归属靠 fiscalPeriodFor 容差）
 */
export function nominalQuarterEnds(fye, asOf, count) {
  const mm = Number(fye.slice(0, 2)) - 1;
  const dd = Number(fye.slice(2));
  const monthEnd = dd === daysInMonth(2001, mm); // 非闰年判月末（0229 不存在）
  const out = [];
  const limit = ms(asOf);
  const startYear = new Date(limit).getUTCFullYear() + 1;
  // 年份下界留 2 年余量：起点是 asOf 次年，前几个候选必然晚于 asOf 被跳过
  for (let y = startYear; out.length < count && y > startYear - count - 2; y--) {
    for (let k = 0; k < 4 && out.length < count; k++) {
      let m = mm - 3 * k;
      let yy = y;
      while (m < 0) { m += 12; yy -= 1; }
      const day = monthEnd ? daysInMonth(yy, m) : Math.min(dd, daysInMonth(yy, m));
      const t = Date.UTC(yy, m, day);
      if (t <= limit) {
        const periodEnd = iso(t);
        out.push({ periodEnd, ...fiscalPeriodFor(periodEnd, fye) });
      }
    }
  }
  return out;
}

/** 最近已结束的名义季末（早于 filingDate 至少 7 天）——新闻稿类申报（8-K / 6-K）归属到这一季 */
export function quarterForRelease(filingDate, fye) {
  const asOf = iso(ms(filingDate) - 7 * DAY);
  return nominalQuarterEnds(fye, asOf, 1)[0];
}

/**
 * 申报 → doc_kind；不在研究范围内返回 null。
 * 修正案（/A）一律不收：10-K/A 多半只补 Part III，6-K/A 是新闻稿勘误，阶段1不处理（数据质量里不计缺失）。
 */
export function classifyFiling({ form, items, primaryDocument }, company) {
  if (!form || form.endsWith('/A')) return null;
  if (company.filer === 'foreign') {
    if (form === '20-F') return 'annual';
    if (form === '6-K') {
      for (const [kind, re] of Object.entries(company.sixK || {})) {
        if (re.test(primaryDocument || '')) return kind;
      }
    }
    return null;
  }
  if (form === '10-Q') return 'periodic';
  if (form === '10-K') return 'annual';
  if (form === '8-K' && String(items || '').split(',').map(s => s.trim()).includes('2.02')) return 'earnings_release';
  return null;
}

/** submissions.filings.recent（列式数组）→ 行对象 */
export function flattenRecent(recent) {
  const n = recent?.accessionNumber?.length || 0;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      accession: recent.accessionNumber[i],
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] || null,
      items: recent.items?.[i] || '',
      primaryDocument: recent.primaryDocument?.[i] || '',
    });
  }
  return rows;
}

/**
 * 归属财季：定期报告与 TSM 6-K 用 EDGAR reportDate（即期末）；8-K 的 reportDate 是事件日，按申报日推算。
 * @returns {{periodEnd, fiscalYear, fiscalQuarter}}
 */
export function periodForFiling(row, kind, fye) {
  const usesReportDate = kind === 'periodic' || kind === 'annual' || (row.form === '6-K' && row.reportDate);
  if (usesReportDate && row.reportDate) {
    return { periodEnd: row.reportDate, ...fiscalPeriodFor(row.reportDate, fye) };
  }
  return quarterForRelease(row.filingDate, fye);
}

/**
 * 从申报索引页（<accession>-index.htm）的文件表里找指定类型的文件名（如 'EX-99.1'）。
 * 表格列：Seq | Description | Document | Type | Size。找不到精确类型时退到同前缀（EX-99 → EX-99.01 等写法）
 */
export function findDocumentByType(indexHtml, type) {
  const rows = String(indexHtml).match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const parsed = rows.map(r => {
    const cells = (r.match(/<td[\s\S]*?<\/td>/gi) || []).map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim());
    const href = /href="([^"]+)"/i.exec(r)?.[1] || '';
    return { cells, name: href.split('/').pop() };
  }).filter(r => r.cells.length >= 4 && r.name);
  const exact = parsed.find(r => r.cells[3].toUpperCase() === type.toUpperCase());
  if (exact) return exact.name;
  // 同号不同写法（EX-99.01 / EX-99.1）：按"前缀 + 数值序号"比较，EX-99.2 不会误配 EX-99.1
  const norm = t => {
    const m = /^(.*?)\.0*(\d+)$/.exec(t.toUpperCase());
    return m ? `${m[1]}.${m[2]}` : t.toUpperCase();
  };
  const loose = parsed.find(r => norm(r.cells[3]) === norm(type) && /\.html?$/i.test(r.name));
  return loose ? loose.name : null;
}
