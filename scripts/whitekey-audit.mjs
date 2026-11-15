import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { normKana } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, readRegistrants, showDate } from "../lib/whitekeyClient.mjs";

// 自動入力した結果の二重チェック(読み取り専用)。台帳に記録された入力を、whitekeyの実際の受付と1人ずつ照合する。
//   ・入っているか / 氏名のカナ / 性別 / 料金 / 年齢(25) / 電話(00000000000) / きっかけ / 予約状況(完了)
//   ・二重入力の疑い: 同じパーティーに、同じ姓・同じ性別・同じきっかけの受付が2件以上あり、そのうち1件が自動入力のもの
//   ・パーティーごとの人数: 受付済み(完了)の人数
// 使い方: node scripts/whitekey-audit.mjs --from=2026/11/16 --to=2026/11/22   → data/whitekey-audit.csv と画面の要約
const arg = (n, d = "") => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const parseYmd = (t) => { const [y, m, d] = t.split("/").map(Number); return new Date(y, m - 1, d); };
const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
const from = parseYmd(arg("from"));
const to = parseYmd(arg("to"));
const sheetId = process.env.SHEET_ID;

const ledgerAll = Object.values(await readWhitekeyLedger(sheetId));
const dayOfLedger = (l) => { const [m, d] = String(l.eventDate).split("/").map(Number); let dt = new Date(from.getFullYear(), m - 1, d); return dt; };
const ledger = ledgerAll.filter((l) => l.partycode && dayOfLedger(l) >= from && dayOfLedger(l) <= to);
const ledgerKeys = new Set(ledger.map((l) => l.bookingKey));
console.log(`台帳(自動入力): ${ledger.length}件 / ${ymd(from)}〜${ymd(to)}`);

// 入れた内容の「期待値」を、いまの予約から組み立て直す(台帳を空にして、台帳にある予約だけ取り出す)
const [raw, official] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET)]);
const wantedEvents = new Set(official.filter((e) => { const d = dayOfLedger({ eventDate: `${e.month}/${e.day}` }); return d >= from && d <= to; }).map((e) => e.canonicalEventId));
const { entries } = await buildEntries({ raw, official, ledger: {}, sources: ["kokuchpro", "wpBookings", "peatix"], eventFilter: (e) => wantedEvents.has(e.canonicalEventId) });
const expectedByKey = new Map(entries.map((e) => [e.bookingKey, e]));

const wk = await openWhitekey();
const regsByParty = new Map();
const partyInfo = new Map();
try {
  await openPartyList(wk.page);
  const dates = [...new Set(ledger.map((l) => ymd(dayOfLedger(l))))].sort();
  for (const date of dates) {
    await showDate(wk.page, date);
    const parties = await readParties(wk.page);
    for (const code of [...new Set(ledger.filter((l) => ymd(dayOfLedger(l)) === date).map((l) => l.partycode))]) {
      const p = parties.find((x) => x.partycode === code);
      if (p) partyInfo.set(code, { date, time: p.time, hall: p.hall, done: p.doneMen + p.doneWomen });
      await showDate(wk.page, date);
      regsByParty.set(code, await readRegistrants(wk.page, code));
    }
  }
} finally {
  await wk.close();
}

const seiOf = (kana) => normKana(String(kana).split(/[\s　]/)[0]);
const problems = [];
const rowsOut = [];
for (const l of ledger) {
  const regs = (regsByParty.get(l.partycode) || []);
  const exp = expectedByKey.get(l.bookingKey);
  const info = partyInfo.get(l.partycode) || {};
  if (!exp) { problems.push({ level: "要確認", ledger: l, why: "台帳の予約が、いまの予約データに見つかりません(キャンセル・変更の可能性)" }); continue; }
  const used = new Set();
  exp.people.forEach((person, i) => {
    const ours = normKana(person.sei + (/^[0-9]+$/.test(person.mei) ? "" : person.mei));
    // 完了の受付から、姓名が一致するものを探す(番号付きの名は、姓+番号で探す)
    const hit = regs.find((r) => !used.has(r) && r.status === "完了" && normKana(r.kana) === ours) ||
      regs.find((r) => !used.has(r) && r.status === "完了" && seiOf(r.kana) === normKana(person.sei) && /[0-9]/.test(r.kana));
    const base = { date: info.date || "", time: info.time || "", hall: (info.hall || "").slice(0, 10), platform: exp.platform, name: exp.originalName, person: i === 0 ? "本人" : `同伴${i}`, ours: `${person.sei} ${person.mei}` };
    if (!hit) { rowsOut.push({ ...base, result: "NG", detail: "whitekeyに見つかりません" }); problems.push({ level: "NG", ledger: l, why: `whitekeyに見つかりません: ${base.ours}` }); return; }
    used.add(hit);
    const issues = [];
    const sex = exp.sexkbn === "2" ? "女" : "男";
    if (hit.gender !== sex) issues.push(`性別 ${hit.gender}(期待 ${sex})`);
    if (Number(hit.fee || 0) !== Number(exp.fee)) issues.push(`料金 ${hit.fee}(期待 ${exp.fee})`);
    if (String(hit.age) !== "25") issues.push(`年齢 ${hit.age}`);
    if (String(hit.tel) !== "00000000000") issues.push(`電話 ${hit.tel}`);
    if (i === 0 && hit.keiyu !== exp.keiyu.label) issues.push(`きっかけ ${hit.keiyu}(期待 ${exp.keiyu.label})`);
    rowsOut.push({ ...base, result: issues.length ? "NG" : "OK", detail: issues.join(" / ") || `${hit.kana} ${sex} ${hit.fee}円 ${hit.keiyu || "(同伴)"}` });
    if (issues.length) problems.push({ level: "NG", ledger: l, why: `${base.ours}: ${issues.join(" / ")}` });
  });
}

// 二重入力の疑い: 同じパーティーで、同じ姓・性別・きっかけの受付(完了)が2件以上 → 自動入力のものが含まれる場合
const ledgerSeiByParty = new Map();
for (const l of ledger) (ledgerSeiByParty.get(l.partycode) || ledgerSeiByParty.set(l.partycode, new Set()).get(l.partycode)).add(normKana(l.sei));
const suspects = [];
for (const [code, regs] of regsByParty) {
  const done = regs.filter((r) => r.status === "完了" && r.keiyu);
  const groups = new Map();
  for (const r of done) { const k = `${seiOf(r.kana)}|${r.gender}|${r.keiyu}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    if (!ledgerSeiByParty.get(code)?.has(k.split("|")[0])) continue;
    suspects.push({ code, info: partyInfo.get(code) || {}, list: list.map((r) => `${r.kana}`), key: k });
  }
}

const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
fs.writeFileSync("data/whitekey-audit.csv", "﻿" + ["結果,日付,開始,会場,取得先,元の氏名,対象,入力した読み,内容", ...rowsOut.map((r) => [r.result, r.date, r.time, r.hall, r.platform, r.name, r.person, r.ours, r.detail].map(cell).join(","))].join("\r\n"));
fs.writeFileSync("data/whitekey-audit-suspects.json", JSON.stringify(suspects, null, 1));
const ok = rowsOut.filter((r) => r.result === "OK").length;
const ng = rowsOut.filter((r) => r.result === "NG").length;
console.log(`照合: ${rowsOut.length}人分 / OK ${ok} / NG ${ng} / 台帳の予約が見つからない ${problems.filter((p) => p.level === "要確認").length}`);
for (const p of problems.slice(0, 30)) console.log(`  [${p.level}] ${p.ledger.eventDate} ${p.ledger.venue} ${p.ledger.time} ${p.ledger.name}: ${p.why}`);
console.log(`二重入力の疑い(同じ姓・性別・きっかけが2件以上): ${suspects.length}組`);
for (const s of suspects.slice(0, 30)) console.log(`  ${s.info.date} ${s.info.time} ${(s.info.hall || "").slice(0, 8)}: ${s.list.join(" / ")}`);
console.log("出力: data/whitekey-audit.csv, data/whitekey-audit-suspects.json");
