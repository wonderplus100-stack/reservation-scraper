import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { annotateParties, matchParty, normKana } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, readRegistrants, showDate } from "../lib/whitekeyClient.mjs";

// 入力テスト用の候補を選ぶ。whitekeyは読むだけ(受付ボタン・登録は押さない)。
// 選ぶ条件(二重入力と入力ミスを避けるため、厳しめ):
//   ・これから開催(今日〜--days日先)で、whitekeyに対応するパーティーが1つに決まる
//   ・要確認の項目(氏名の区切りの推定・性別の推定・金額不明など)が無い
//   ・同行者がいない(1人1件)・姓と名の読みが両方分かる(名の欄が番号にならない)・ローマ字の氏名ではない
//   ・そのパーティーに、同じ姓の受付が(キャンセル含め)まだ1件も無い(重複判定を強化しない前提でも二重入力にならない)
//   ・台帳に無い
// 使い方: node scripts/whitekey-test-candidates.mjs [--days=2] [--limit=12]
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split("=")[1];
const days = Number(arg("days", 2));
const limit = Number(arg("limit", 12));
const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
const today = new Date(); today.setHours(0, 0, 0, 0);
const seiKana = (text) => normKana(String(text).split(/[\s　]/)[0]);

const sheetId = process.env.SHEET_ID;
const [raw, official, ledger] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET), readWhitekeyLedger(sheetId)]);
const dayOf = (e) => { let d = new Date(today.getFullYear(), Number(e.month) - 1, Number(e.day)); if (d < today) d = new Date(today.getFullYear() + 1, Number(e.month) - 1, Number(e.day)); return d; };
const inRange = (e) => { const d = dayOf(e); return d >= today && (d - today) / 86400000 <= days; };
const { entries } = await buildEntries({ raw, official, ledger, sources: ["kokuchpro", "wpBookings", "peatix"], eventFilter: inRange });
console.log(`対象期間の入力予定: ${entries.length}件`);

const wk = await openWhitekey();
const candidates = [];
const rejected = {};
const reject = (why) => (rejected[why] = (rejected[why] || 0) + 1);
try {
  await openPartyList(wk.page);
  const partiesByDate = new Map();
  const regsByParty = new Map();
  for (const e of entries) {
    if (e.reasons.length) { reject("要確認の項目あり"); continue; }
    if (e.people.length > 1) { reject("同行者あり"); continue; }
    // 名の読みが分からず番号(1,2…)になる予約・ローマ字の氏名(名→姓の並びで姓名が逆になる)は、読みを人が決めたいので除く
    if (/^[0-9]+$/.test(e.people[0].mei)) { reject("名の読みが分からない(名の欄が番号)"); continue; }
    if (/^[A-Za-z]/.test(e.originalName)) { reject("ローマ字の氏名"); continue; }
    const date = ymd(dayOf(e));
    if (!partiesByDate.has(date)) { await showDate(wk.page, date); partiesByDate.set(date, annotateParties(await readParties(wk.page))); }
    const { party, state } = matchParty(e, partiesByDate.get(date));
    if (!party) { reject(`パーティー: ${state}`); continue; }
    if (!regsByParty.has(party.partycode)) {
      await showDate(wk.page, date);
      regsByParty.set(party.partycode, await readRegistrants(wk.page, party.partycode));
    }
    const sei = normKana(e.people[0].sei);
    if (regsByParty.get(party.partycode).some((r) => seiKana(r.kana) === sei)) { reject("同じ姓の受付がすでにある"); continue; }
    candidates.push({ entry: e, party, date, partyRegistrants: regsByParty.get(party.partycode).length });
  }
} finally {
  await wk.close();
}
console.log("除外の内訳:", JSON.stringify(rejected));
// 取得先がばらけるように選ぶ(公式サイト → Peatix → こくちーず(Whitekey) の順に1件ずつ)
const byPlatform = {};
for (const c of candidates) (byPlatform[c.entry.platform] ||= []).push(c);
const picked = [];
for (let round = 0; picked.length < limit; round += 1) {
  let any = false;
  for (const p of ["wpBookings", "peatix", "kokuchpro"]) {
    const c = (byPlatform[p] || [])[round];
    if (c && picked.length < limit) { picked.push(c); any = true; }
  }
  if (!any) break;
}
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/whitekey-test-candidates.json", JSON.stringify(picked.map((c) => ({ bookingKey: c.entry.bookingKey, date: c.date, party: c.party.partycode })), null, 1));
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const header = ["日付", "会場", "開始", "パーティー", "取得先", "元の氏名", "入力する姓", "入力する名", "性別", "性別の根拠", "料金", "料金の根拠", "きっかけ", "パーティーの既存受付数"];
fs.writeFileSync("data/whitekey-test-candidates.csv", "﻿" + [header.join(","), ...picked.map((c) => { const e = c.entry; return [c.date, e.venue, e.time, c.party.partycode, `${e.platform}/${e.account}`, e.originalName, e.people[0].sei, e.people[0].mei, e.sexkbn === "2" ? "女" : "男", e.genderBasis, e.fee, e.feeBasis, e.keiyu.label, c.partyRegistrants].map(cell).join(","); })].join("\r\n"));
console.log(`候補: ${candidates.length}件 / 提示: ${picked.length}件`);
for (const c of picked) {
  const e = c.entry;
  console.log(`${c.date.slice(5)} ${e.venue} ${e.time} | ${e.platform}/${String(e.account).slice(-10)} | ${e.originalName} → ${e.people[0].sei} ${e.people[0].mei} | ${e.sexkbn === "2" ? "女" : "男"}(${e.genderBasis}) | ${e.fee}円(${e.feeBasis}) | ${e.keiyu.label} | ${c.party.partycode}`);
}
