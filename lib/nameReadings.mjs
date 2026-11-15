import fs from "node:fs";
import path from "node:path";
import { NAME_READINGS_SHEET, readNameReadings, replaceNameReadings } from "./sheetsClient.mjs";

// 「学習した読み」: スタッフが whitekey に入れた実際のカナ(正解)から集めた、漢字 → 読み の対応表。
// 人名読み辞典(外部サイト)や形態素解析より優先して使う。スプレッドシートの NameReadings シートに保存し、
// どのPCでも同じ表を使う(氏名を含むため、GitHubには置かない)。
//   kind: "sei"(姓) | "mei"(名) / kanji: 漢字(異体字は標準の字に直したもの) / reading: ひらがな / count: 観測した回数
const store = new Map(); // `${kind}:${kanji}` -> Map(reading -> count)

const keyOf = (kind, kanji) => `${kind}:${kanji}`;

export function clearLearnedReadings() {
  store.clear();
  knownSeiCache = null;
}

export function addLearnedReading(kind, kanji, reading, count = 1) {
  if (!kanji || !reading) return;
  const key = keyOf(kind, kanji);
  knownSeiCache = null;
  if (!store.has(key)) store.set(key, new Map());
  const readings = store.get(key);
  readings.set(reading, (readings.get(reading) || 0) + count);
}

// いちばん多く観測された読みを返す(同数なら先に覚えたもの)。無ければ null。
export function learnedReading(kind, kanji) {
  const readings = store.get(keyOf(kind, kanji));
  if (!readings || readings.size === 0) return null;
  let best = null;
  let bestCount = -1;
  for (const [reading, count] of readings) {
    if (count > bestCount) { best = reading; bestCount = count; }
  }
  return best;
}

// 姓の読みとして既に知られているものの集合(学習した姓の読み + data/jinmei-cache.json にある姓の読みの候補)
let knownSeiCache = null;
export function knownSeiReadings() {
  if (knownSeiCache) return knownSeiCache;
  const set = new Set();
  for (const [key, readings] of store) if (key.startsWith("sei:")) for (const r of readings.keys()) set.add(r);
  try {
    const cache = JSON.parse(fs.readFileSync(path.resolve("data", "jinmei-cache.json"), "utf8"));
    for (const [key, list] of Object.entries(cache)) if (key.startsWith("sei:") && Array.isArray(list)) list.forEach((r) => set.add(r));
  } catch {
    // キャッシュが無ければ、学習した分だけ
  }
  knownSeiCache = set;
  return set;
}

export function learnedRows() {
  const rows = [];
  for (const [key, readings] of store) {
    const [kind, ...rest] = key.split(":");
    for (const [reading, count] of readings) rows.push({ kind, kanji: rest.join(":"), reading, count });
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.kanji.localeCompare(b.kanji, "ja"));
}

// buildEntries の最初に呼ぶ: 学習した読みを(まだなら)シートから読み込む。1つのプロセスで1回だけ。
// NAME_LEARNING=off、または disableAutoLoad() で、読み込まない(学習の評価用)。
let autoLoaded = false;
let autoLoadDisabled = process.env.NAME_LEARNING === "off";
export function disableAutoLoad() {
  autoLoadDisabled = true;
}
export async function ensureLearnedLoaded(sheetId = process.env.SHEET_ID) {
  if (autoLoaded || autoLoadDisabled || !sheetId) return;
  autoLoaded = true;
  await loadLearnedReadings(sheetId).catch(() => 0);
}

export async function loadLearnedReadings(sheetId) {
  const rows = await readNameReadings(sheetId).catch(() => []);
  for (const row of rows) addLearnedReading(row.kind, row.kanji, row.reading, Number(row.count) || 1);
  return rows.length;
}

export async function saveLearnedReadings(sheetId) {
  await replaceNameReadings(sheetId, learnedRows().map((row) => ({ ...row, updatedAt: new Date().toISOString() })));
}

export { NAME_READINGS_SHEET };
