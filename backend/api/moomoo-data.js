// moomoo OpenD 本地网关行情层（美股 LV3 实时行情）
// 仅当 MOOMOO_WS_PORT 已配置时启用；连接失败静默降级（provider 返回 null，回落 Yahoo→Tiingo→TwelveData）
// 注意：OpenD 需在设置中启用 WebSocket 端口（默认33333，与 Python SDK 的 TCP 11111 是两个开关）
// 权限边界（用户账户实测）：美股股票 LV3 可用；NYMEX期货/OTC/韩股无权限——这些标的自动回落后续源
import ftPkg from 'futu-api';
import proto from 'futu-api/proto.js';

const ftWebsocket = ftPkg.default ?? ftPkg;
const { Qot_Common } = proto;
const US = Qot_Common.QotMarket.QotMarket_US_Security;

const HOST = () => process.env.MOOMOO_WS_HOST || '127.0.0.1';
const PORT = () => process.env.MOOMOO_WS_PORT;
const KEY = () => process.env.MOOMOO_WS_KEY || null;

export function moomooEnabled() {
  return !!PORT();
}

// 美股普通代码才走 moomoo：期货(含=)、外市后缀(.KS等)直接跳过
function isUsSymbol(symbol) {
  return /^[A-Z][A-Z0-9]*$/.test(symbol);
}

let ws = null;
let loginPromise = null;
let unavailableUntil = 0; // 连接失败后的冷却窗口，避免每次请求都等超时

function connect() {
  if (Date.now() < unavailableUntil) return Promise.resolve(null);
  if (loginPromise) return loginPromise;

  loginPromise = new Promise(resolve => {
    const sock = new ftWebsocket();
    const timer = setTimeout(() => {
      unavailableUntil = Date.now() + 60_000;
      loginPromise = null;
      try { sock.stop(); } catch { /* noop */ }
      console.warn('[moomoo] OpenD WebSocket 连接超时（检查 OpenD 设置中的 WebSocket 端口开关）');
      resolve(null);
    }, 4000);

    sock.onlogin = ret => {
      clearTimeout(timer);
      if (!ret) {
        unavailableUntil = Date.now() + 60_000;
        loginPromise = null;
        resolve(null);
        return;
      }
      ws = sock;
      resolve(sock);
    };
    sock.start(HOST(), Number(PORT()), false, KEY());
  });
  return loginPromise;
}

/**
 * 日线收盘价（前复权），与 market-data 其他 provider 同形：升序 [{date, close}] 或 null
 */
export async function closesFromMoomoo(symbol, startDate, endDate) {
  if (!moomooEnabled() || !isUsSymbol(symbol)) return null;
  const sock = ws || await connect();
  if (!sock) return null;
  const res = await sock.RequestHistoryKL({ c2s: {
    rehabType: Qot_Common.RehabType.RehabType_Forward,
    klType: Qot_Common.KLType.KLType_Day,
    security: { market: US, code: symbol },
    beginTime: startDate,
    endTime: endDate,
  } });
  const closes = (res?.s2c?.klList || [])
    .map(k => ({ date: String(k.time).slice(0, 10), close: k.closePrice }))
    .filter(b => b.close !== null && b.close !== undefined && !isNaN(b.close));
  return closes.length ? closes : null;
}

/**
 * 实时快照报价（LV3）：含 PE/PB；P/S 由后续 FMP 补全，与 yahoo provider 同形
 */
export async function quoteFromMoomoo(symbol) {
  if (!moomooEnabled() || !isUsSymbol(symbol)) return null;
  const sock = ws || await connect();
  if (!sock) return null;
  const res = await sock.GetSecuritySnapshot({ c2s: {
    securityList: [{ market: US, code: symbol }],
  } });
  const snap = res?.s2c?.snapshotList?.[0];
  const price = snap?.basic?.curPrice;
  if (price === null || price === undefined || !price) return null;
  const pe = snap?.equityExData?.peTTMRate ?? snap?.equityExData?.peRate ?? null;
  return {
    price,
    // 亏损公司PE为负，按行业惯例视为"无PE"（与Yahoo口径一致）
    trailingPE: pe !== null && pe > 0 ? pe : null,
    forwardPE: null,
    priceToSales: null, // moomoo 快照无P/S，由 FMP ratios 补全
    priceToBook: snap?.equityExData?.pbRate ?? null,
    shortName: snap?.basic?.name ?? null,
    source: 'moomoo',
  };
}
