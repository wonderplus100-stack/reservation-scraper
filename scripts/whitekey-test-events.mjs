import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { annotateParties, findDuplicate, matchParty, normKana } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, readRegistrants, showDate } from "../lib/whitekeyClient.mjs";

// 入力テストの「イベント単位」の候補を出す。whitekeyは読むだけ(受付ボタン・登録は押さない)。
// 各イベントについて、入力予定の件数・要確認の件数・whitekeyに既にある受付の数・重複しそうな人数を並べる。
// 使い方: node scripts/whitekey-test-events.mjs [--days=5]
const days = Number((process.argv.find((a) => a.startsWith("--days=")) || "--days=5").slice(7));
const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
const today = new Date(); today.setHours(0, 0, 0, 0);
const seiKana = (t) => normKana(String(t).split(/[\s　]/)[0]);
const sheetId = process.env.SHEET_ID;
const [raw, official, ledger] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET), readWhitekeyLedger(sheetId)]);
const dayOf = (e) => { let d = new Date(today.getFullYear(), Number(e.month) - 1, Number(e.day)); if (d < today) d = new Date(today.getFullYear() + 1, Number(e.month) - 1, Number(e.day)); return d; };
const inRange = (e) => { const d = dayOf(e); return d >= today && (d - today) / 86400000 <= days; };
const { entries } = await buildEntries({ raw, official, ledger, sources: ["kokuchpro", "wpBookings", "peatix"], eventFilter: inRange });

const byEvent = new Map();
for (const e of entries) (byEvent.get(e.canonicalEventId) || byEvent.set(e.canonicalEventId, []).get(e.canonicalEventId)).push(e);

const wk = await openWhitekey();
const rows = [];
try {
  await openPartyList(wk.page);
  const partiesByDate = new Map();
  for (const [id, list] of byEvent) {
    const first = list[0];
    const date = ymd(dayOf(first));
    if (!partiesByDate.has(date)) { await showDate(wk.page, date); partiesByDate.set(date, annotateParties(await readParties(wk.page))); }
    const { party, state } = matchParty(first, partiesByDate.get(date));
    let regs = [];
    if (party) { await showDate(wk.page, date); regs = await readRegistrants(wk.page, party.partycode); }
    const active = regs.filter((r) => r.status === "完了");
    const exact = list.filter((e) => findDuplicate(e, regs)).length;
    const bySei = list.filter((e) => regs.some((r) => seiKana(r.kana) === normKana(e.people[0].sei))).length;
    rows.push({
      id, date, venue: first.venue, time: first.time, name: first.eventName.replace(/^\d+\/\d+\s+\S+\s+/, "").slice(0, 26),
      party: party ? party.partycode : "", state, entries: list.length, people: list.reduce((n, e) => n + e.people.length, 0),
      needsCheck: list.filter((e) => e.reasons.length).length, existing: active.length, dupExact: exact, dupSei: bySei,
      platforms: [...new Set(list.map((e) => e.platform))].join("+")
    });
  }
} finally {
  await wk.close();
}
rows.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
fs.writeFileSync("data/whitekey-test-events.json", JSON.stringify(rows, null, 1));
for (const r of rows) {
  console.log(`${r.date.slice(5)} ${r.venue} ${r.time} | ${r.party || r.state} | 入力予定${r.entries}件/${r.people}名 要確認${r.needsCheck} | whitekey既存${r.existing}名 重複(完全${r.dupExact}/姓${r.dupSei}) | ${r.platforms} | ${r.name}`);
}
