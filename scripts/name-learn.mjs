import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { normKana } from "../lib/whitekeyMatch.mjs";
import { toWhitekeyName, normalizeVariantKanji } from "../lib/whitekeyName.mjs";
import { clearLearnedReadings, addLearnedReading, learnedRows, loadLearnedReadings, saveLearnedReadings, disableAutoLoad } from "../lib/nameReadings.mjs";

disableAutoLoad(); // buildEntries がシートの学習を自動で読まないようにする(評価・学習は、ここで明示的に扱う)
import { lookupReadings } from "../lib/jinmeiDictionary.mjs";

// スタッフが whitekey に入れた実際のカナ(正解)から、漢字 → 読み を学習する(NameReadings シート)。
//   node scripts/name-learn.mjs --eval     … 学習の効果を測る(イベントを半分に分け、片方で学習して、もう片方で当たる率を比べる)。シートは変更しない
//   node scripts/name-learn.mjs --save     … 全イベントから学習して NameReadings シートに保存する(既存の学習は残して回数を足す)
// 元データ: data/whitekey-reconcile-raw.json(scripts/whitekey-reconcile.mjs が whitekey から読み取って保存したもの)
const mode = process.argv.includes("--save") ? "save" : "eval";
const raw = JSON.parse(fs.readFileSync("data/whitekey-reconcile-raw.json", "utf8"));
const [rr, oo] = await Promise.all([readSheetAsObjects(process.env.SHEET_ID, RAW_DATA_SHEET), readSheetAsObjects(process.env.SHEET_ID, OFFICIAL_EVENTS_SHEET)]);
const rowByKey = new Map(rr.map((r) => [r.bookingKey, r]));
const ids = new Set(raw.events.map((e) => e.id));

const toHira = (t) => String(t).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
// whitekeyのカナ(「P」などの媒体の頭文字・番号付き)を、姓・名のひらがなにする。名が無い/番号なら mei は空。
function staffSeiMei(kana) {
  const text = String(kana).normalize("NFKC").replace(/^(?:JP|EJ|EM|WP|P)(?=[ァ-ヶ])/i, "");
  const parts = text.split(/[\s　]+/).filter(Boolean);
  const clean = (t) => toHira(t.replace(/[0-9]/g, ""));
  const sei = clean(parts[0] || "");
  const mei = clean(parts.slice(1).join(""));
  return { sei, mei };
}
function dist(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// 予約の氏名を、いまの(または旧の)プログラムで読んだ結果
async function predict(entries, impl) {
  const out = new Map();
  for (const e of entries) {
    const row = rowByKey.get(e.bookingKey) || {};
    const r = await impl(e.originalName, row.readingKatakana);
    out.set(e.bookingKey, r);
  }
  return out;
}

const { entries: allEntries } = await buildEntries({ raw: rr, official: oo, ledger: {}, sources: ["kokuchpro", "wpBookings", "peatix"], eventFilter: (e) => ids.has(e.canonicalEventId) });
// 読みの根拠が無い予約(媒体のフリガナが無い)だけが、学習の対象・評価の対象
const entries = allEntries.filter((e) => !String((rowByKey.get(e.bookingKey) || {}).readingKatakana || "").trim() && e.people.length >= 1);

// 予約 ↔ whitekeyの受付 の対応づけ: 同じイベント・同じ性別・同じきっかけの中で、読みが近い順に1対1(現在のプログラムの読みを使う)
clearLearnedReadings();
const basePred = await predict(entries, toWhitekeyName);
const pairs = [];
for (const ev of raw.events) {
  const mine = entries.filter((e) => e.canonicalEventId === ev.id);
  const regs = (raw.registrantsByParty[ev.party] || []).filter((r) => r.status === "完了");
  const cand = [];
  mine.forEach((m, mi) => regs.forEach((r, ri) => {
    if (r.gender !== (m.sexkbn === "2" ? "女" : "男")) return;
    if (r.keiyu && r.keiyu !== m.keiyu.label && !(r.keiyu === "" )) return;
    const p = basePred.get(m.bookingKey);
    const ours = normKana(p.sei + (p.hasGivenName ? p.mei : ""));
    const theirs = normKana(r.kana);
    const d = dist(ours, theirs);
    if (d <= Math.max(4, Math.ceil(theirs.length * 0.7))) cand.push({ mi, ri, d });
  }));
  cand.sort((a, b) => a.d - b.d);
  const um = new Set(), ur = new Set();
  for (const c of cand) {
    if (um.has(c.mi) || ur.has(c.ri)) continue;
    um.add(c.mi); ur.add(c.ri);
    pairs.push({ event: ev.id, entry: mine[c.mi], staff: staffSeiMei(regs[c.ri].kana), staffKana: regs[c.ri].kana });
  }
}
console.log(`対応づけできた予約: ${pairs.length}件(対象 ${entries.length}件)`);

// 学習: 姓の読みが分かっている(スタッフの姓が、予約の姓の読み候補に含まれる)ペアだけ使い、姓・名の漢字の区切りを決めて覚える
async function learnFrom(list) {
  const rows = [];
  for (const p of list) {
    const name = normalizeVariantKanji(p.entry.originalName).replace(/[★☆※]/g, " ").trim();
    if (!/[一-龠々]/.test(name) || !p.staff.sei || !p.staff.mei) continue;
    let seiText = "", meiText = "";
    const parts = name.split(/[\s　]+/).filter(Boolean);
    if (parts.length >= 2) { seiText = parts[0]; meiText = parts.slice(1).join(""); }
    else {
      for (let k = 1; k <= Math.min(3, name.length - 1); k += 1) {
        const cands = (await lookupReadings("sei", name.slice(0, k))) || [];
        if (cands.includes(p.staff.sei)) { seiText = name.slice(0, k); meiText = name.slice(k); if (k >= 2) break; }
      }
    }
    if (!seiText || !meiText || meiText.length > 4) continue;
    rows.push({ kind: "sei", kanji: seiText, reading: p.staff.sei });
    rows.push({ kind: "mei", kanji: meiText, reading: p.staff.mei });
  }
  return rows;
}

if (mode === "eval") {
  const evIds = raw.events.map((e) => e.id);
  const train = new Set(evIds.filter((_, i) => i % 2 === 0));
  const trainPairs = pairs.filter((p) => train.has(p.event));
  const testPairs = pairs.filter((p) => !train.has(p.event));
  const learnedRowsList = await learnFrom(trainPairs);
  learnedRowsList.forEach((r) => addLearnedReading(r.kind, r.kanji, r.reading));
  const score = async (impl, list) => {
    let exact = 0, seiOk = 0;
    for (const p of list) {
      const r = await impl(p.entry.originalName, "");
      const sei = normKana(r.sei), mei = normKana(r.mei);
      const okSei = sei === normKana(p.staff.sei);
      const okMei = p.staff.mei ? mei === normKana(p.staff.mei) : true;
      if (okSei) seiOk += 1;
      if (okSei && okMei) exact += 1;
    }
    return { n: list.length, exact: `${(exact / list.length * 100).toFixed(1)}%`, seiOk: `${(seiOk / list.length * 100).toFixed(1)}%` };
  };
  const { toWhitekeyName: oldImpl } = await import("../lib/_whitekeyNameOld.mjs");
  const withName = testPairs.filter((p) => p.staff.mei);
  console.log("評価(学習に使っていないイベント、スタッフの名が分かる人のみ)", withName.length, "件 / 学習に使った漢字:", learnedRowsList.length / 2);
  clearLearnedReadings();
  console.log("旧プログラム  ", JSON.stringify(await score(oldImpl, withName)));
  console.log("新(学習なし)  ", JSON.stringify(await score(toWhitekeyName, withName)));
  learnedRowsList.forEach((r) => addLearnedReading(r.kind, r.kanji, r.reading));
  console.log("新(学習あり)  ", JSON.stringify(await score(toWhitekeyName, withName)));
  // 誤りの内訳: スタッフの名の読みが、辞典の候補に載っているか(載っている=選び方の問題 / 載っていない=辞典に無い)
  const wrong = [];
  for (const p of withName) {
    const r = await toWhitekeyName(p.entry.originalName, "");
    if (normKana(r.sei) === normKana(p.staff.sei) && normKana(r.mei) === normKana(p.staff.mei)) continue;
    const name = normalizeVariantKanji(p.entry.originalName).replace(/[★☆※s]/g, "");
    let inDict = false;
    for (let k = 1; k <= 3; k += 1) { const c = (await lookupReadings("mei", name.slice(k))) || []; if (c.includes(p.staff.mei)) inDict = true; }
    wrong.push({ name: p.entry.originalName, ours: r.sei + " " + r.mei, staff: p.staff.sei + " " + p.staff.mei, inDict, seiOk: normKana(r.sei) === normKana(p.staff.sei) });
  }
  fs.writeFileSync("data/name-eval-wrong.json", JSON.stringify(wrong, null, 1));
  console.log("誤り", wrong.length, "件: 姓の誤り", wrong.filter((w) => !w.seiOk).length, "/ 名の誤りで辞典に正解あり", wrong.filter((w) => w.seiOk && w.inDict).length, "/ 辞典に無い", wrong.filter((w) => w.seiOk && !w.inDict).length);
} else {
  await loadLearnedReadings(process.env.SHEET_ID);
  const before = learnedRows().length;
  const rows = await learnFrom(pairs);
  rows.forEach((r) => addLearnedReading(r.kind, r.kanji, r.reading));
  await saveLearnedReadings(process.env.SHEET_ID);
  console.log(`学習した(漢字,読み)の組: ${before} → ${learnedRows().length}(今回 ${rows.length / 2} 人分を反映)`);
}
