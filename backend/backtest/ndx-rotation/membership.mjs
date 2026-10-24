// 时点成分股：2007-02-01 起用 thuningxu/sp500nq100 快照（逐次变更行），2026-05-18 之后的变更用 unliftedq/index-constitution 区间表补；
// 2007 年以前用 QQQ 信托 9/30 全持仓表（SEC 485BPOS / N-30B-2）推断，见 build-universe.mjs。
import fs from 'fs';
import path from 'path';
import { DATA } from './lib.mjs';

const SRC = path.join(DATA, 'src');
export function thuSnapshots() {
  const L = fs.readFileSync(path.join(SRC, 'thu_ndx.csv'), 'utf8').replace(/\r/g, '').trim().split('\n').slice(1);
  return L.map(l => { const i = l.indexOf(','); return { date: l.slice(0, i), tickers: l.slice(i + 1).replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) }; });
}
export function unlIntervals() {
  const L = fs.readFileSync(path.join(SRC, 'unl_history_ndx.csv'), 'utf8').replace(/^﻿/, '').replace(/\r/g, '').trim().split('\n').slice(1);
  return L.map(l => { const m = l.match(/^([^,]+),(".*?"|[^,]*),([^,]*),([^,]*)$/); return m && { sym: m[1], name: m[2].replace(/"/g, ''), from: m[3], to: m[4] || null }; }).filter(Boolean);
}
const THU = thuSnapshots();
const UNL = unlIntervals();
export const THU_LAST = THU.at(-1).date;
export const UNL_START = '2006-01-01';

/** unl 区间表：opt-in 当日起是成员，opt-out 当日起不是 */
export function unlAt(d) { return UNL.filter(r => r.from <= d && (!r.to || r.to > d)).map(r => r.sym); }

/** 某日成员（d >= 2007-02-01）。THU 末行之后：以 THU 末行为底，叠加 unl 在 (THU_LAST, d] 的进出。 */
export function membersAt(d) {
  if (d < THU[0].date) return null;
  let snap = THU[0];
  for (const s of THU) if (s.date <= d) snap = s; else break;
  const set = new Set(snap.tickers);
  if (d > THU_LAST) for (const r of UNL) {
    if (r.from > THU_LAST && r.from <= d) set.add(r.sym);
    if (r.to && r.to > THU_LAST && r.to <= d) set.delete(r.sym);
  }
  return [...set];
}
