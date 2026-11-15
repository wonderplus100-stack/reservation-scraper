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

const RAW_PATH = "data/whitekey-audit-raw.json";
const offline = process.argv.includes("--offline"); // 保存済みの読み取り結果(前回の実行)で、照合だけやり直す
const regsByParty = new Map();
const partyInfo = new Map();
const wk = offline ? null : await openWhitekey();
if (offline) {
  const saved = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
  Object.entries(saved.regs).forEach(([k, v]) => regsByParty.set(k, v));
  Object.entries(saved.info).forEach(([k, v]) => partyInfo.set(k, v));
} else try {
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
if (!offline) fs.writeFileSync(RAW_PATH, JSON.stringify({ regs: Object.fromEntries(regsByParty), info: Object.fromEntries(partyInfo) }));

const seiOf = (kana) => normKana(String(kana).split(/[\s　]/)[0]);
const problems = [];
const rowsOut = [];
for (const l of ledger) {
  const regs = (regsByParty.get(l.partycode) || []);
  const exp = expectedByKey.get(l.bookingKey);
  const info = partyInfo.get(l.partycode) || {};
  if (!exp) { problems.push({ level: "要確認", ledger: l, why: "台帳の予約が、いまの予約データに見つかりません(キャンセル・変更の可能性)" }); continue; }
  // 台帳に記録した姓(入力した時の読み)で始まる受付(完了)を、人数分探す。入力後に読みのルールを変えても、入れた時の姓で照合できる。
  const used = new Set();
  const n = Number(l.people || 1);
  const found = [];
  for (let i = 0; i < n; i += 1) {
    const sexExp = exp.sexkbn === "2" ? "女" : "男";
    const pool = regs.filter((r) => !used.has(r) && r.status === "完了" && normKana(r.kana).startsWith(normKana(l.sei)));
    const rank = (r) => (r.gender === sexExp ? 0 : 2) + (i > 0 || r.keiyu === exp.keiyu.label ? 0 : 1) + (/[0-9０-９]/.test(r.kana) === (i > 0) ? 0 : 0.5);
    const hit = pool.sort((a, b) => rank(a) - rank(b))[0];
    if (hit) { used.add(hit); found.push(hit); }
  }
  const base = { date: info.date || "", time: info.time || "", hall: (info.hall || "").slice(0, 10), platform: exp.platform, name: exp.originalName };
  if (found.length < n) {
    rowsOut.push({ ...base, person: "本人", ours: l.sei, result: "NG", detail: `whitekeyに${found.length}/${n}名しか見つかりません` });
    problems.push({ level: "NG", ledger: l, why: `whitekeyに見つかりません(${found.length}/${n}名): ${l.sei}` });
  }
  found.forEach((hit, i) => {
    const issues = [];
    const sex = exp.sexkbn === "2" ? "女" : "男";
    if (hit.gender !== sex) issues.push(`性別 ${hit.gender}(期待 ${sex})`);
    if (Number(hit.fee || 0) !== Number(l.fee)) issues.push(`料金 ${hit.fee}(台帳 ${l.fee})`);
    if (String(hit.age) !== "25") issues.push(`年齢 ${hit.age}`);
    if (String(hit.tel) !== "00000000000") issues.push(`電話 ${hit.tel}`);
    if (i === 0 && hit.keiyu !== exp.keiyu.label) issues.push(`きっかけ ${hit.keiyu}(期待 ${exp.keiyu.label})`);
    // 入れた後にルールが変わった(Jua Partyは事前決済=0円)ものは、別に知らせる
    const note = Number(exp.fee) !== Number(l.fee) && Number(hit.fee || 0) === Number(l.fee) ? `※現在のルールでは料金 ${exp.fee}円(入力時 ${l.fee}円)` : "";
    rowsOut.push({ ...base, person: i === 0 ? "本人" : `同伴${i}`, ours: hit.kana, result: issues.length ? "NG" : note ? "要確認" : "OK", detail: issues.join(" / ") || note || `${hit.kana} ${sex} ${hit.fee}円 ${hit.keiyu || "(同伴)"}` });
    if (issues.length) problems.push({ level: "NG", ledger: l, why: `${hit.kana}: ${issues.join(" / ")}` });
    else if (note) problems.push({ level: "要確認", ledger: l, why: `${hit.kana}: ${note}` });
  });
}

// 二重入力の疑い: 同じパーティーで、同じ性別の受付(完了)のうち、カナがほぼ同じ(番号を除き、違いが2文字以内)2件。
// 読みが少し違うだけの同じ人(「ドロノワ マシロ」と「ドロノワ マサヨ」、「イトウ」と「イト」)を拾う。片方が自動入力のものを含む組だけ出す。
const normPlain = (k) => normKana(String(k).replace(/[0-9０-９]/g, ""));
const dist = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
};
const ledgerSeiByParty = new Map();
for (const l of ledger) (ledgerSeiByParty.get(l.partycode) || ledgerSeiByParty.set(l.partycode, new Set()).get(l.partycode)).add(normKana(l.sei));
const suspects = [];
for (const [code, regs] of regsByParty) {
  const done = regs.filter((r) => r.status === "完了");
  const ours = (r) => [...(ledgerSeiByParty.get(code) || [])].some((s) => normKana(r.kana).startsWith(s));
  for (let i = 0; i < done.length; i += 1) {
    for (let j = i + 1; j < done.length; j += 1) {
      const a = done[i], b = done[j];
      if (a.gender !== b.gender) continue;
      const pa = normPlain(a.kana), pb = normPlain(b.kana);
      if (pa.length < 4 || pb.length < 4) continue;
      if (dist(pa, pb) > 2) continue;
      if (!ours(a) && !ours(b)) continue;
      suspects.push({ code, info: partyInfo.get(code) || {}, list: [`${a.kana}(${a.keiyu || "-"})`, `${b.kana}(${b.keiyu || "-"})`] });
    }
  }
}

const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
fs.writeFileSync("data/whitekey-audit.csv", "﻿" + ["結果,日付,開始,会場,取得先,元の氏名,対象,入力した読み,内容", ...rowsOut.map((r) => [r.result, r.date, r.time, r.hall, r.platform, r.name, r.person, r.ours, r.detail].map(cell).join(","))].join("\r\n"));
fs.writeFileSync("data/whitekey-audit-suspects.json", JSON.stringify(suspects, null, 1));
const ok = rowsOut.filter((r) => r.result === "OK").length;
const check = rowsOut.filter((r) => r.result === "要確認").length;
const ng = rowsOut.filter((r) => r.result === "NG").length;
console.log(`照合: ${rowsOut.length}人分 / OK ${ok} / 要確認(ルール変更) ${check} / NG ${ng} / 台帳の予約が見つからない ${problems.filter((p) => p.level === "要確認").length}`);
for (const p of problems.slice(0, 30)) console.log(`  [${p.level}] ${p.ledger.eventDate} ${p.ledger.venue} ${p.ledger.time} ${p.ledger.name}: ${p.why}`);
console.log(`二重入力の疑い(同じ姓・性別・きっかけが2件以上): ${suspects.length}組`);
for (const s of suspects.slice(0, 30)) console.log(`  ${s.info.date} ${s.info.time} ${(s.info.hall || "").slice(0, 8)}: ${s.list.join(" / ")}`);
console.log("出力: data/whitekey-audit.csv, data/whitekey-audit-suspects.json");
