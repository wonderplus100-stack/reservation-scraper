import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";

// 入力テストに選んだイベント(data/whitekey-test-events.json の中から --events=<番号,番号> で指定)の、入力内容を全件出す。whitekeyには触れない。
// 使い方: node scripts/whitekey-test-plan.mjs --pick=銀座@11/17 13:00,大阪@11/17 13:00
const pick = (process.argv.find((a) => a.startsWith("--pick=")) || "--pick=").slice(7).split(",").filter(Boolean);
const events = JSON.parse(fs.readFileSync("data/whitekey-test-events.json", "utf8"));
const chosen = events.filter((e) => pick.includes(`${e.venue}@${e.date.slice(5)} ${e.time}`));
const ids = new Set(chosen.map((e) => e.id));
const sheetId = process.env.SHEET_ID;
const [raw, official, ledger] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET), readWhitekeyLedger(sheetId)]);
const { entries } = await buildEntries({ raw, official, ledger, sources: ["kokuchpro", "wpBookings", "peatix"], eventFilter: (e) => ids.has(e.canonicalEventId) });
fs.writeFileSync("data/whitekey-test-events-selected.json", JSON.stringify([...ids]));
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const header = ["日付", "会場", "開始", "パーティー", "取得先", "元の氏名", "入力する姓", "入力する名", "同行者", "性別", "性別の根拠", "料金", "料金の根拠", "きっかけ", "要確認"];
const partyOf = (id) => (chosen.find((c) => c.id === id) || {}).party || "";
fs.writeFileSync("data/whitekey-test-plan.csv", "\uFEFF" + [header.join(","), ...entries.map((e) => [`${e.month}/${e.day}`, e.venue, e.time, partyOf(e.canonicalEventId), `${e.platform}/${e.account}`, e.originalName, e.people[0].sei, e.people[0].mei, e.people.length - 1, e.sexkbn === "2" ? "女" : "男", e.genderBasis, e.fee, e.feeBasis, e.keiyu.label, e.reasons.join(" / ")].map(cell).join(","))].join("\r\n"));
console.log(`入力予定 ${entries.length}件 / ${entries.reduce((n, e) => n + e.people.length, 0)}名 / 要確認 ${entries.filter((e) => e.reasons.length).length}件`);
const reasonCount = {};
entries.forEach((e) => e.reasons.forEach((r) => (reasonCount[r] = (reasonCount[r] || 0) + 1)));
console.log(JSON.stringify(reasonCount));
for (const c of chosen) console.log(`${c.date.slice(5)} ${c.venue} ${c.time} ${c.party}: ${entries.filter((e) => e.canonicalEventId === c.id).length}件`);
