import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { annotateParties, findDuplicate, matchParty, normKana } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, readRegistrants, showDate } from "../lib/whitekeyClient.mjs";

// 過去N日(既定7日)〜今日の、「入力アルゴリズムが作る入力予定」と whitekey に実際に入っている受付を、イベントごとに突き合わせる。
// whitekeyは読むだけ(受付ボタンも登録も押さない)。結果は data/whitekey-reconcile.json。
// 使い方: node scripts/whitekey-reconcile.mjs [--days=7]
const days = Number((process.argv.find((a) => a.startsWith("--days=")) || "--days=7").slice(7));
const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
const SOURCES = ["kokuchpro", "wpBookings", "peatix"];

const today = new Date(); today.setHours(0, 0, 0, 0);
const from = new Date(today); from.setDate(from.getDate() - days);
const sheetId = process.env.SHEET_ID;
const [raw, official] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET)]);
const dateOf = (e) => {
  let d = new Date(today.getFullYear(), Number(e.month) - 1, Number(e.day));
  if (d > today) d = new Date(today.getFullYear() - 1, Number(e.month) - 1, Number(e.day));
  return d;
};
const inRange = (e) => { const d = dateOf(e); return d >= from && d <= today; };
const { entries } = await buildEntries({ raw, official, ledger: {}, sources: SOURCES, eventFilter: inRange });
const events = official.filter(inRange);
const dates = [...new Set(events.map((e) => ymd(dateOf(e))))].sort();

const wk = await openWhitekey();
const partiesByDate = new Map();
const registrantsByParty = new Map();
try {
  await openPartyList(wk.page);
  for (const date of dates) {
    await showDate(wk.page, date);
    const shown = await wk.page.inputValue('input[name="searchInputDate"]');
    if (shown !== date) console.warn(`警告: ${date} を表示したつもりが ${shown} でした`);
    partiesByDate.set(date, annotateParties(await readParties(wk.page)).map((p) => ({ ...p, hasReceptionButton: true })));
  }
  // 入力予定のあるイベント(+ 参加者が居そうなイベント)に当たるパーティーの、受付済み一覧を読む
  const wanted = new Map(); // date -> Set(partycode)
  for (const e of events) {
    const date = ymd(dateOf(e));
    const { party } = matchParty({ venue: e.venue, time: e.time, eventName: e.canonicalEventName }, partiesByDate.get(date) || []);
    if (party) { if (!wanted.has(date)) wanted.set(date, new Set()); wanted.get(date).add(party.partycode); }
  }
  for (const [date, codes] of wanted) {
    for (const code of codes) {
      await showDate(wk.page, date);
      registrantsByParty.set(code, await readRegistrants(wk.page, code));
    }
  }
} finally {
  await wk.close();
}

const rows = [];
for (const e of events.sort((a, b) => dateOf(a) - dateOf(b) || String(a.time).localeCompare(String(b.time)))) {
  const date = ymd(dateOf(e));
  const { party, state } = matchParty({ venue: e.venue, time: e.time, eventName: e.canonicalEventName }, partiesByDate.get(date) || []);
  const mine = entries.filter((x) => x.canonicalEventId === e.canonicalEventId);
  const planPeople = mine.reduce((n, x) => n + x.people.length, 0);
  const regs = party ? registrantsByParty.get(party.partycode) || [] : [];
  const matched = [], notInWhitekey = [];
  const used = new Set();
  for (const m of mine) {
    const dup = findDuplicate(m, regs.filter((r) => !used.has(r)));
    if (dup) { used.add(dup); matched.push(m); } else notInWhitekey.push(m);
  }
  const onlyWhitekey = regs.filter((r) => !used.has(r));
  rows.push({
    date, venue: e.venue, time: e.time, event: e.canonicalEventName, partycode: party ? party.partycode : "", matchState: state,
    plan: { bookings: mine.length, people: planPeople },
    whitekey: { registrants: regs.length, men: regs.filter((r) => r.gender === "男").length, women: regs.filter((r) => r.gender === "女").length, done: party ? party.doneMen + party.doneWomen : null },
    matched: matched.length,
    notInWhitekey: notInWhitekey.map((m) => ({ platform: m.platform, account: m.account, name: m.originalName, people: m.people.length, gender: m.sexkbn === "2" ? "女" : "男", genderBasis: m.genderBasis, fee: m.fee })),
    onlyWhitekey: onlyWhitekey.map((r) => ({ kana: r.kana, gender: r.gender, keiyu: r.keiyu, status: r.status }))
  });
}
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(path.resolve("data", "whitekey-reconcile.json"), JSON.stringify(rows, null, 1));
for (const r of rows) {
  if (!r.plan.bookings && !r.whitekey.registrants) continue;
  console.log(`${r.date.slice(5)} ${r.venue} ${r.time} | 予定${r.plan.bookings}件/${r.plan.people}名 | whitekey ${r.matchState === "一致" ? `${r.whitekey.registrants}名(男${r.whitekey.men}/女${r.whitekey.women})` : r.matchState} | 一致${r.matched} 予定のみ${r.notInWhitekey.length} whitekeyのみ${r.onlyWhitekey.length} | ${r.event.slice(0, 28)}`);
}
fs.writeFileSync(path.resolve("data", "whitekey-reconcile-raw.json"), JSON.stringify({
  entries: entries.map((m) => ({ canonicalEventId: m.canonicalEventId, platform: m.platform, account: m.account, name: m.originalName, sei: m.people[0].sei, mei: m.people[0].mei, people: m.people.map((p) => p.sei + " " + p.mei), gender: m.sexkbn === "2" ? "女" : "男", genderBasis: m.genderBasis, fee: m.fee, keiyu: m.keiyu.label })),
  events: events.map((e) => ({ id: e.canonicalEventId, date: ymd(dateOf(e)), venue: e.venue, time: e.time, name: e.canonicalEventName, party: (matchParty({ venue: e.venue, time: e.time, eventName: e.canonicalEventName }, partiesByDate.get(ymd(dateOf(e))) || []).party || {}).partycode || "" })),
  registrantsByParty: Object.fromEntries(registrantsByParty)
}));
