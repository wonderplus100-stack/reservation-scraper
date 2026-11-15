import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { normKana } from "../lib/whitekeyMatch.mjs";

// whitekey-reconcile.mjs が保存した whitekey の受付(data/whitekey-reconcile-raw.json)と、いまの予約から作った入力予定を比べ、
// 「予約はあるのに whitekey に見つからない人(入力漏れの候補)」を一覧にする。whitekeyには触れない(保存済みの読み取り結果を使う)。
// 各候補は、見つからない理由を次のように分ける:
//   ・whitekeyでキャンセル済み: 同じ姓の受付が、このパーティーに「キャンセル/取消」で入っている(予約側は有効)
//   ・別のパーティーに入力済み: 同じ姓・同じきっかけの受付が、同じ週の別のパーティーにある
//   ・読み違いの可能性: 同じパーティーに、同じきっかけで、どの予定とも照合できなかった受付が残っている(同数まで)
//   ・入力漏れの候補: 上のどれでもない
// 使い方: node scripts/whitekey-missing.mjs → data/whitekey-missing.csv
const raw = JSON.parse(fs.readFileSync("data/whitekey-reconcile-raw.json", "utf8"));
const [rr, oo] = await Promise.all([readSheetAsObjects(process.env.SHEET_ID, RAW_DATA_SHEET), readSheetAsObjects(process.env.SHEET_ID, OFFICIAL_EVENTS_SHEET)]);
const ids = new Set(raw.events.map((e) => e.id));
const { entries } = await buildEntries({ raw: rr, official: oo, ledger: {}, sources: ["kokuchpro", "wpBookings", "peatix"], eventFilter: (e) => ids.has(e.canonicalEventId) });
const seiOf = (kana) => normKana(String(kana).split(/[\s　]/)[0]);
const MEDIA = new Set(["こくちーず", "Wonder+公式サイト", "Peatix"]);
const rowsOut = [];
const allRegs = Object.entries(raw.registrantsByParty).flatMap(([party, regs]) => regs.map((r) => ({ ...r, party })));

for (const ev of raw.events) {
  const mine = entries.filter((e) => e.canonicalEventId === ev.id);
  const regsAll = raw.registrantsByParty[ev.party] || [];
  const regs = regsAll.filter((r) => r.status === "完了");
  const cancelled = regsAll.filter((r) => r.status !== "完了");
  const used = new Set();
  const ourKey = (m) => normKana(m.people[0].sei + (/^\d+$/.test(m.people[0].mei) ? "" : m.people[0].mei));
  const left = [];
  for (const m of mine) {
    const hit = regs.find((r) => !used.has(r) && normKana(r.kana) === ourKey(m));
    if (hit) used.add(hit); else left.push(m);
  }
  const left2 = [];
  for (const m of left) {
    const hit = regs.find((r) => !used.has(r) && seiOf(r.kana) === normKana(m.people[0].sei));
    if (hit) used.add(hit); else left2.push(m);
  }
  // 照合できなかった受付(媒体由来のきっかけ)を、同じ数だけ「読み違いの可能性」に充てる
  const spare = regs.filter((r) => !used.has(r) && MEDIA.has(r.keiyu));
  for (const m of left2) {
    const sei = normKana(m.people[0].sei);
    let state = "";
    if (!ev.party) state = "whitekeyにこのパーティーが無い";
    else if (cancelled.some((r) => seiOf(r.kana) === sei)) state = "whitekeyでキャンセル済み(予約側は有効)";
    else if (allRegs.some((r) => r.party !== ev.party && r.status === "完了" && seiOf(r.kana) === sei && r.keiyu === m.keiyu.label)) state = "別のパーティーに入力済み";
    else if (spare.length > 0) { spare.shift(); state = "読み違いの可能性(同じ回に未照合の受付あり)"; }
    else state = "入力漏れの候補";
    rowsOut.push({ date: ev.date, venue: ev.venue, time: ev.time, event: ev.name.replace(/^\d+\/\d+\s+\S+\s+/, "").slice(0, 28), platform: m.platform, account: m.account, name: m.originalName, people: m.people.length, gender: m.sexkbn === "2" ? "女" : "男", state });
  }
}
const order = ["入力漏れの候補", "whitekeyにこのパーティーが無い", "whitekeyでキャンセル済み(予約側は有効)", "別のパーティーに入力済み", "読み違いの可能性(同じ回に未照合の受付あり)"];
rowsOut.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const header = ["判定", "日付", "会場", "開始", "イベント", "取得先", "アカウント", "氏名", "人数", "性別"];
fs.writeFileSync("data/whitekey-missing.csv", "﻿" + [header.join(","), ...rowsOut.map((r) => [r.state, r.date, r.venue, r.time, r.event, r.platform, r.account, r.name, r.people, r.gender].map(cell).join(","))].join("\r\n"));
const count = {};
rowsOut.forEach((r) => (count[r.state] = (count[r.state] || 0) + 1));
console.log(JSON.stringify(count, null, 1), "合計", rowsOut.length);
