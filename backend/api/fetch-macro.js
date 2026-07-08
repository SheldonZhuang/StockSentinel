import axios from 'axios';
import cfg from '../config/signal.config.js';
import { deriveBalanceSheetStatus } from './signal.js';
import { getLastFomcDecisionDate } from '../config/fomc-meetings.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const { FRED_SERIES, RATE_LOOKBACK_DAYS, BALANCE_SHEET_LOOKBACK_DAYS } = cfg;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchSeries(seriesId, startDate, apiKey, units = '') {
  const unitsParam = units ? `&units=${units}` : '';
  const url = `${FRED_BASE}?series_id=${seriesId}&observation_start=${startDate}&api_key=${apiKey}&file_type=json&sort_order=desc${unitsParam}`;
  const res = await axios.get(url, { timeout: 15000 });
  return res.data.observations || [];
}

/**
 * 查询某一期数据的真实首次发布日期（realtime_start）
 * @returns {string|null} 'YYYY-MM-DD'
 */
async function fetchReleaseDate(seriesId, periodDate, apiKey) {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${FRED_BASE}?series_id=${seriesId}&observation_start=${periodDate}&observation_end=${periodDate}&realtime_start=2020-01-01&realtime_end=${today}&api_key=${apiKey}&file_type=json`;
  const res = await axios.get(url, { timeout: 15000 });
  const obs = res.data.observations || [];
  return obs[0]?.realtime_start || null;
}

function latestValue(observations) {
  for (const obs of observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) return v;
  }
  return null;
}

function latestDate(observations) {
  for (const obs of observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) return obs.date;
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

  const currentBalanceSheet = latestValue(bsObs);
  const prevBalanceSheet = prevValue(bsObs);
  const balanceSheetPeriodDate = latestDate(bsObs);
  const corePcePeriodDate = latestDate(corePceObs);
  const trimmedPcePeriodDate = latestDate(trimmedPceObs);
  const unemploymentPeriodDate = latestDate(unrateObs);

  const [corePceReleaseDate, trimmedPceReleaseDate, unemploymentReleaseDate] = await Promise.all([
    corePcePeriodDate ? fetchReleaseDate(FRED_SERIES.CORE_PCE, corePcePeriodDate, apiKey) : null,
    trimmedPcePeriodDate ? fetchReleaseDate(FRED_SERIES.TRIMMED_MEAN_PCE, trimmedPcePeriodDate, apiKey) : null,
    unemploymentPeriodDate ? fetchReleaseDate(FRED_SERIES.UNEMPLOYMENT, unemploymentPeriodDate, apiKey) : null,
  ]);

  return {
    currentRate: latestValue(rateObs),
    prevRate: prevValue(rateObs),
    currentBalanceSheet,
    prevBalanceSheet,
    corePce: latestValue(corePceObs),
    trimmedPce: latestValue(trimmedPceObs),
    unemployment: latestValue(unrateObs),

    // 议息会议决定日期（利率每日更新，真正的"决定"日以 FOMC 日历为准）
    rateDecisionDate: getLastFomcDecisionDate(),

    // 资产负债表：H.4.1 每周四发布，对应上周三数据，发布日 = 参考周三 + 1天
    balanceSheetPeriodDate,
    balanceSheetReleaseDate: balanceSheetPeriodDate ? addDays(balanceSheetPeriodDate, 1) : null,
    balanceSheetStatus: deriveBalanceSheetStatus(currentBalanceSheet, prevBalanceSheet),

    corePcePeriodDate,
    corePceReleaseDate,
    trimmedPcePeriodDate,
    trimmedPceReleaseDate,
    unemploymentPeriodDate,
    unemploymentReleaseDate,
  };
}
