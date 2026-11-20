import "dotenv/config";
import { RAW_DATA_SHEET, readNameKana, readSheetAsObjects, replaceNameKana } from "../lib/sheetsClient.mjs";
import { ensureLearnedLoaded } from "../lib/nameReadings.mjs";
import { emailLocalLetters, hasPaymentWords, toWhitekeyName } from "../lib/whitekeyName.mjs";

// 予約者名 → カタカナ(「セイ メイ」)の対応表(NameKana シート)を作る。ダッシュボードの「名前一覧をコピー」が、
// 全員カタカナでコピーできるようにするため。媒体にフリガナ(readingKatakana)がある予約は、そちらを使うので対象外。
// 読みは、whitekeyの入力と同じ氏名変換(学習した読み・人名読み辞典・形態素解析)で決める。
// 新しい名前だけを追加する(既に表にある名前は、--refresh を付けない限り作り直さない)。開催日が今日に近い名前から、1回に最大 --cap 件(既定 400)。
// 使い方: node scripts/build-name-kana.mjs [--cap=400] [--refresh]
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split("=")[1];
const cap = Number(arg("cap", 400));
const refresh = process.argv.includes("--refresh");
const sheetId = process.env.SHEET_ID;

const toKata = (t) => String(t).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const KATA_ONLY = /^[ァ-ヶー・\s　]+$/;
const baseName = (n) => String(n || "").replace(/\(同行\d+\)$/, "").trim();

await ensureLearnedLoaded(sheetId);
const [raw, existingRows] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readNameKana(sheetId).catch(() => [])]);
const existing = new Map(existingRows.map((r) => [r.name, r]));

// 開催日の近さ(今日からの日数。月日から推定)で並べる。開催日の分からない名前は後回し。
const today = new Date(); today.setHours(0, 0, 0, 0);
const distance = (eventId) => {
  const m = String(eventId || "").match(/^official-(\d+)-(\d+)-/);
  if (!m) return 9999;
  let d = new Date(today.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  if (d - today > 200 * 86400000) d = new Date(today.getFullYear() - 1, Number(m[1]) - 1, Number(m[2]));
  return Math.abs((d - today) / 86400000);
};
const best = new Map();
for (const r of raw) {
  if (String(r.readingKatakana || "").trim()) continue;
  const key = baseName(r.reservationName);
  if (!key || KATA_ONLY.test(key)) continue;
  const dist = distance(r.canonicalEventId);
  if (!best.has(key) || dist < best.get(key)) best.set(key, dist);
}
// 決済済みの文言を含む名前・メールアドレスの名前は、以前の変換が不適切だったため、表にあっても作り直す(2026-11-20)
const needsRebuild = (name) => hasPaymentWords(name) || emailLocalLetters(name).length >= 2;
const todo = [...best.entries()].filter(([name]) => refresh || !existing.has(name) || needsRebuild(name)).sort((a, b) => a[1] - b[1]).slice(0, cap);
console.log(`カタカナにする名前: 対象 ${best.size}件 / 今回 ${todo.length}件(表にある名前 ${existing.size}件)`);

const now = new Date().toISOString();
let done = 0;
for (const [name] of todo) {
  const r = await toWhitekeyName(name, "");
  const kata = toKata(r.hasGivenName && r.mei ? `${r.sei} ${r.mei}` : r.sei);
  if (!kata) continue;
  existing.set(name, { name, katakana: kata, updatedAt: now });
  done += 1;
}
await replaceNameKana(sheetId, [...existing.values()]);
console.log(`NameKana を更新しました: 追加・更新 ${done}件 / 合計 ${existing.size}件 / 残り ${Math.max(0, [...best.keys()].filter((n) => !existing.has(n)).length)}件`);
