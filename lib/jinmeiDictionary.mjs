import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

// 「人名読み辞典」(http://mobile.shinsv.mydns.jp/jinmei/ 、姓・名の漢字から読みの候補を引く
// 外部サイト)を読みの参考にする。サイトへの負担を避けるため、同じ名前は
// 結果をファイル(data/jinmei-cache.json)に保存して再利用し、新しい問い合わせは
// 1回ごとに間隔を空ける。サイトはShift_JISで、候補に順位は付かない。
const BASE_URL = "http://mobile.shinsv.mydns.jp/jinmei/";
const CACHE_PATH = path.resolve("data", "jinmei-cache.json");
const REQUEST_INTERVAL_MS = 1500;

let cache = null;
let lastRequestAt = 0;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
}

function percentSjis(text) {
  return [...iconv.encode(text, "Shift_JIS")].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
}

// kind: "sei"(姓) | "mei"(名)。返り値: 読み(ひらがな)の候補の配列。見つからなければ空配列。
// サイトに接続できない場合は null を返し、呼び出し側は辞書なしで続行する。
export async function lookupReadings(kind, kanji) {
  const store = loadCache();
  const key = `${kind}:${kanji}`;
  if (key in store) return store[key];

  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const other = kind === "sei" ? "mei" : "sei";
  const body = `${kind}=${percentSjis(kanji)}&${other}=&find_${kind}=`;
  let html;
  try {
    const res = await fetch(`${BASE_URL}?mode=serch_${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return null;
    html = new TextDecoder("shift_jis").decode(await res.arrayBuffer());
  } catch {
    return null;
  }

  const readings = [];
  const rowPattern = /<TR><TD><A href="\?mode=(?:sei|mei)_print[^>]*>([^<]*)<\/A><\/TD>\s*<TD><A [^>]*>([^<]*)<\/A><\/TD>/g;
  for (const match of html.matchAll(rowPattern)) {
    if (match[1] === kanji && !readings.includes(match[2])) readings.push(match[2]);
  }
  store[key] = readings;
  saveCache();
  return readings;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// 辞書の候補と、形態素解析による推定の読み(guess)を突き合わせて1つ選ぶ。
//  ・guess が候補に含まれる → guess  ・候補が1つ → その候補
//  ・候補が複数で guess と合わない → guess に最も近い候補  ・候補なし → guess
export function pickReading(candidates, guess) {
  if (!candidates || candidates.length === 0) return guess;
  if (candidates.includes(guess)) return guess;
  if (candidates.length === 1) return candidates[0];
  return [...candidates].sort((a, b) => editDistance(a, guess) - editDistance(b, guess))[0];
}
