import fs from "node:fs";
import path from "node:path";

// 取得を軽くするための共通部品。
//  1. 古いイベントを開かない: 終了から一定日数(既定30日)たったイベントは、取得しない。
//  2. 前回から変わっていないイベントを開かない: 一覧に申込数が出る媒体(Peatix)は、申込数が前回と同じで、
//     前回の取得から一定時間(既定6時間)以内なら、そのイベントは開かない。
//  開かなかったイベントの予約は、スプレッドシートにある前回までのデータを引き継いで保持する(消さない)。
//  1.の古いイベントについても、前回までのデータは、そのまま残す。
export const MAX_AGE_DAYS = Number(process.env.FETCH_MAX_AGE_DAYS) || 30;
const REFRESH_HOURS = Number(process.env.FETCH_REFRESH_HOURS) || 6;
const STATE_PATH = path.resolve("data", "fetch-state.json");

export function cutoffDate(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - MAX_AGE_DAYS);
  return d;
}

// 「2026年11月13日」のような文言から日付を取り出す(無ければ null)。
export function parseJaDate(text) {
  const m = String(text || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function isTooOld(date, now = new Date()) {
  return Boolean(date) && date < cutoffDate(now);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

// 申込数が前回と同じで、前回の取得が REFRESH_HOURS 以内なら true(=今回は開かなくてよい)
export function isUnchanged(key, count) {
  const entry = readState()[key];
  return Boolean(entry) && entry.count === count && Date.now() - entry.at < REFRESH_HOURS * 3600000;
}

export function rememberFetched(key, count) {
  const state = readState();
  state[key] = { count, at: Date.now() };
  // 古い記録は消す(30日)
  const cutoff = Date.now() - 30 * 86400000;
  for (const [k, v] of Object.entries(state)) if (v.at < cutoff) delete state[k];
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}
