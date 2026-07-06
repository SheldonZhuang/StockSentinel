import axios from 'axios';
import cfg from '../config/signal.config.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const { FRED_SERIES, RATE_LOOKBACK_DAYS, BALANCE_SHEET_LOOKBACK_DAYS } = cfg;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchSeries(seriesId, startDate, apiKey, units = '') {
  const unitsParam = units ? `&units=${units}` : '';
  const url = `${FRED_BASE}?series_id=${seriesId}&observation_start=${startDate}&api_key=${apiKey}&file_type=json&sort_order=desc${unitsParam}`;
  const res = await axios.get(url, { timeout: 15000 });
  return res.data.observations || [];
}

function latestValue(observations) {
  for (const obs of observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) return v;
  }
  return null;
}

function prevValue(observations) {
  let found = 0;
  for (const obs of observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) {
      found++;
      if (found === 2) return v;
    }
  }
  return null;
}

/**
 * 拉取所有 FRED 指标，返回结构化对象
 * @returns {object} macroData
 */
export async function fetchMacroData() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');

  const rateStart = daysAgo(RATE_LOOKBACK_DAYS);
  const bsStart = daysAgo(BALANCE_SHEET_LOOKBACK_DAYS);
  const pceStart = daysAgo(400); // PCE 月度数据，取最近数期
  const unStart = daysAgo(400);

  const [rateObs, bsObs, corePceObs, trimmedPceObs, unrateObs] = await Promise.all([
    fetchSeries(FRED_SERIES.RATE, rateStart, apiKey),
    fetchSeries(FRED_SERIES.BALANCE_SHEET, bsStart, apiKey),
    fetchSeries(FRED_SERIES.CORE_PCE, pceStart, apiKey, 'pc1'),       // 同比变动百分比
    fetchSeries(FRED_SERIES.TRIMMED_MEAN_PCE, pceStart, apiKey),       // 本身就是年化变动率
    fetchSeries(FRED_SERIES.UNEMPLOYMENT, unStart, apiKey),
  ]);

  return {
    currentRate: latestValue(rateObs),
    prevRate: prevValue(rateObs),
    currentBalanceSheet: latestValue(bsObs),
    prevBalanceSheet: prevValue(bsObs),
    corePce: latestValue(corePceObs),
    trimmedPce: latestValue(trimmedPceObs),
    unemployment: latestValue(unrateObs),
    // 原始日期
    rateDate: rateObs[0]?.date || null,
    balanceSheetDate: bsObs[0]?.date || null,
  };
}
