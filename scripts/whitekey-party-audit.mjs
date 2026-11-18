import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { annotateParties, matchParty } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, showDate } from "../lib/whitekeyClient.mjs";

// 台帳(自動入力した予約)が、正しいパーティーに入っているかの確認(読み取り専用)。
// 予約のイベントに対応するパーティーを、いまの照合ルール(lib/whitekeyMatch.mjs)で決め直し、台帳に記録した入力先と比べる。
// 同じ日・同じ会場・同じ開始時刻に、イベントが2つある日(例: 2026-11-18 新宿15:00 の CafeBiz と Beauty Lounge)の取り違えを見つける。
// 使い方: node scripts/whitekey-party-audit.mjs --from=2026/11/16 --to=2026/12/31 → 画面の要約と data/whitekey-party-audit.json
const arg = (n, d = "") => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const parseYmd = (t) => { const [y, m, d] = t.split("/").map(Number); return new Date(y, m - 1, d); };
const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
const from = parseYmd(arg("from", ymd(new Date())));
const to = parseYmd(arg("to", "2026/12/31"));
const sheetId = process.env.SHEET_ID;

const [raw, official, ledgerMap] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET), readWhitekeyLedger(sheetId)]);
const eventOfBooking = new Map();
for (const r of raw) if (r.bookingKey && !eventOfBooking.has(r.bookingKey)) eventOfBooking.set(r.bookingKey, r.canonicalEventId);
const officialById = new Map(official.map((e) => [e.canonicalEventId, e]));
const dateOf = (e) => new Date(from.getFullYear(), Number(e.month) - 1, Number(e.day));
const ledger = Object.values(ledgerMap).filter((l) => l.partycode && eventOfBooking.has(l.bookingKey)).map((l) => ({ l, e: officialById.get(eventOfBooking.get(l.bookingKey)) })).filter(({ e }) => e && dateOf(e) >= from && dateOf(e) <= to);

const wk = await openWhitekey();
const partiesByDate = new Map();
try {
  await openPartyList(wk.page);
  for (const date of [...new Set(ledger.map(({ e }) => ymd(dateOf(e))))].sort()) {
    await showDate(wk.page, date);
    partiesByDate.set(date, annotateParties(await readParties(wk.page)).map((p) => ({ ...p, hasReceptionButton: true })));
  }
} finally {
  await wk.close();
}

const wrong = new Map();
let ok = 0;
for (const { l, e } of ledger) {
  const parties = partiesByDate.get(ymd(dateOf(e))) || [];
  const { party, state } = matchParty({ venue: e.venue, time: e.time, eventName: e.canonicalEventName }, parties);
  if (party && party.partycode === l.partycode) { ok += 1; continue; }
  const key = `${e.canonicalEventId}|${l.partycode}|${party ? party.partycode : state}`;
  if (!wrong.has(key)) wrong.set(key, { event: e.canonicalEventId, name: String(e.canonicalEventName).replace(/^\d+\/\d+\s+\S+\s+/, "").slice(0, 30), enteredPartycode: l.partycode, correctPartycode: party ? party.partycode : state, bookings: [] });
  wrong.get(key).bookings.push({ bookingKey: l.bookingKey, name: l.name, people: l.people, platform: l.platform });
}
const list = [...wrong.values()];
fs.writeFileSync("data/whitekey-party-audit.json", JSON.stringify(list, null, 1));
console.log(`台帳 ${ledger.length}件 / 入力先が正しい ${ok}件 / 入力先が違う、または判定できない ${list.reduce((n, w) => n + w.bookings.length, 0)}件`);
for (const w of list) console.log(`  ${w.event} ${w.name}: ${w.bookings.length}件 入力先 ${w.enteredPartycode} → 正しいのは ${w.correctPartycode}`);
