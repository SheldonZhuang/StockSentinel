// 公司研究 Agent（129号）配置：覆盖公司、各类申报的识别规则与数据质量期限。
// 扩展新公司：加一行即可（CIK 写死，与 ai-chain.config 的 HYPERSCALER_CIK 同口径，避免运行时多一次映射请求）。
//   filer: 'domestic' → 10-Q / 10-K / 8-K(item 2.02, EX-99.1)
//          'foreign'  → 20-F / 6-K（财报新闻稿与季度合并财报靠主文档文件名区分，见 sixK）
export const RESEARCH_COMPANIES = {
  MSFT: { cik: '0000789019', name: 'Microsoft', filer: 'domestic' },
  GOOGL: { cik: '0001652044', name: 'Alphabet', filer: 'domestic' },
  AMZN: { cik: '0001018724', name: 'Amazon', filer: 'domestic' },
  META: { cik: '0001326801', name: 'Meta Platforms', filer: 'domestic' },
  NVDA: { cik: '0001045810', name: 'NVIDIA', filer: 'domestic' },
  AMD: { cik: '0000002488', name: 'Advanced Micro Devices', filer: 'domestic' },
  AVGO: { cik: '0001730168', name: 'Broadcom', filer: 'domestic' },
  // TSM：XBRL 只有 20-F 年度事实（IFRS、新台币）；季度数字只在 6-K 里。
  // 6-K 有上百份（月营收/董事会决议/股利…），只收两类，按主文档名识别（2024-07~2026-10 实测稳定）：
  //   tsm-YYYYMMDDx6k.htm      → 季度财报新闻稿（EX-99.1 含下季指引）
  //   tsm-fsxYYYYMMDDx6k.htm   → 季度合并财报（EX-99.1，IFRS 全文）
  TSM: {
    cik: '0001046179', name: 'TSMC', filer: 'foreign', currency: 'TWD',
    sixK: {
      earnings_release: /^tsm-\d{8}x6k\.htm$/i,
      ifrs_financials: /^tsm-fsx\d{8}x6k\.htm$/i,
    },
  },
};

// 回填/维护的季度窗口
export const QUARTERS_TO_KEEP = 8;

// 每季应有的文件（doc_kind）。Q4 的定期报告是年报（10-K / 20-F）
export const EXPECTED_DOCS = {
  domestic: { quarter: ['earnings_release', 'periodic'], q4: ['earnings_release', 'annual'] },
  foreign: { quarter: ['earnings_release', 'ifrs_financials'], q4: ['earnings_release', 'ifrs_financials', 'annual'] },
};

// 期末后多少天仍未见文件才算"缺失"（之前记为 pending）。取 SEC 法定期限 + 余量：
// 大型加速申报人 10-Q 40 天、10-K 60 天；20-F 4 个月；TSM 季度合并财报惯例约 45 天
export const DOC_DEADLINE_DAYS = {
  earnings_release: 45,
  periodic: 50,
  annual: 75,
  ifrs_financials: 60,
  annual_foreign: 130,
};

// 章节最少字符数：低于此视为空章节（标题后紧跟下一个标题、或只剩"见年报"之类一句话）
export const MIN_SECTION_CHARS = 300;

// 切块目标长度（字符）：按段落边界切，不跨章节、不重叠
export const CHUNK_TARGET_CHARS = 2000;
export const CHUNK_MAX_CHARS = 3000;

// 每类文件必须解析出的章节；缺了记数据质量问题
export const REQUIRED_SECTIONS = {
  '10-Q': ['financial_statements', 'mdna', 'risk_factors'],
  '10-K': ['business', 'risk_factors', 'mdna', 'financial_statements'],
  '20-F': ['risk_factors', 'mdna'],
};

export default { RESEARCH_COMPANIES, QUARTERS_TO_KEEP, EXPECTED_DOCS, DOC_DEADLINE_DAYS, MIN_SECTION_CHARS, CHUNK_TARGET_CHARS, CHUNK_MAX_CHARS, REQUIRED_SECTIONS };
