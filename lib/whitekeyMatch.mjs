// 予約(入力予定の1件)を、whitekeyの一覧に出ているパーティーに結びつける。
// 日付 + 都市 + 開始時刻 で探す(日付は一覧の表示日で絞り込み済みの前提)。
const CITY_WORDS = [
  ["銀座", ["銀座", "有楽町"]],
  ["新宿", ["新宿"]],
  ["大阪", ["梅田", "大阪"]],
  ["名古屋", ["名駅", "名古屋"]],
  ["札幌", ["札幌"]],
  ["神戸", ["神戸"]],
  ["京都", ["京都"]],
  ["横浜", ["横浜"]],
  ["福岡", ["福岡", "博多"]],
  ["熊本", ["熊本"]],
  ["仙台", ["仙台"]],
  ["船橋", ["船橋"]],
  ["宇都宮", ["宇都宮"]],
  ["岡山", ["岡山"]],
  ["広島", ["広島"]]
];

export function cityOfHall(hall) {
  const hit = CITY_WORDS.find(([, words]) => words.some((w) => hall.includes(w)));
  return hit ? hit[0] : "";
}

export function startTime(text) {
  const m = String(text).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

// readParties() の結果に、都市と開始時刻を付ける。
export function annotateParties(parties) {
  return parties.map((p) => ({ ...p, city: cityOfHall(p.hall), start: startTime(p.time) }));
}

// 2つの文章の似ている度合い(0〜1)。空白・記号を除いた、文字の2文字組の一致(Dice係数)。
function titleSimilarity(a, b) {
  const grams = (t) => {
    const s = String(t || "").normalize("NFKC").toLowerCase().replace(/[\s　!-/:-@\[-`{-~、。・「」『』（）()★☆♪♬♥♡～〜…]/g, "");
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common += 1;
  return (2 * common) / (A.size + B.size);
}

// 一致するパーティーを返す。{ party, state }  state: 一致 / whitekeyにパーティーなし / 候補が複数
export function matchParty(entry, parties) {
  // whitekeyには婚活パーティーやホワイトマリッジの相談会も並ぶ。ホワイトマリッジは除き、同じ都市・時刻に
  // 複数ある場合は、タイトルに「Wonder+」を含むもの、さらに公式イベント名のシリーズ名(Business・Gravity 等)で絞る。
  let candidates = parties.filter(
    (p) => p.city === entry.venue && p.start === startTime(entry.time) && p.hasReceptionButton && !p.hall.includes("ホワイトマリッジ")
  );
  if (candidates.length > 1) {
    // Wonder+のパーティーだけに絞る。題名に「Wonder+」が無いWonder+のパーティーがある(2026-11-18 新宿15:00のCafeBiz:
    // 題名は「カジュアルタイプの異業種交流会 …カフェ会形式…」で、「Wonder+」を含まず、同じ時刻の「Beauty Lounge」に
    // 取り違えられて入力された)ため、「Wonder+」を含む、または「交流会」を含み婚活・恋・結婚の語を含まないもの、とする。
    const biz = candidates.filter((p) => /Wonder[+＋]/i.test(p.title) || (/交流会/.test(p.title) && !/婚活|恋|結婚/.test(p.title)));
    if (biz.length >= 1) candidates = biz;
  }
  if (candidates.length > 1) {
    const series = (entry.eventName.match(/Wonder[+＋]\s*([A-Za-z0-9]+)/i) || [])[1]?.toLowerCase();
    const narrowed = series ? candidates.filter((p) => p.title.toLowerCase().includes(series)) : [];
    if (narrowed.length >= 1) candidates = narrowed;
  }
  if (candidates.length > 1) {
    // それでも複数なら、イベント名とパーティーの題名の似ている度合い(文字の2文字組の一致)で選ぶ。差が小さければ選ばない
    // (間違ったパーティーに入れるより、「候補が複数」で入力を止める)。
    const scored = candidates.map((p) => ({ p, s: titleSimilarity(entry.eventName, p.title) })).sort((a, b) => b.s - a.s);
    if (scored[0].s - scored[1].s >= 0.05) candidates = [scored[0].p];
  }
  if (candidates.length === 1) return { party: candidates[0], state: "一致", candidates };
  return { party: null, state: candidates.length === 0 ? "whitekeyにパーティーなし" : "候補が複数", candidates };
}

// ---- すでにwhitekeyに入っている予約との重複判定 ----
// whitekeyの「姓名」はカタカナで入る(スタッフの手入力では、Peatixの人に先頭「P」を付ける運用)。
// ひらがな/カタカナ・空白・「P」の先頭・番号(1,2…)の違いを無視して比べる。
export function normKana(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    // 媒体の頭文字(P/JP/EJ/EM/WP)は、同じ人かの比較では無視する
    .replace(/^(?:JP|EJ|EM|WP|P)(?=[ァ-ヶ])/i, "")
    .replace(/[\s　0-9０-９]/g, "");
}

// entry(代表者)が、すでにwhitekeyにある予約(registrants)と同じ人かを返す。同じなら、その予約を返す。
//  ・姓名(カナ)が一致する → 同じ人
//  ・こちらが名前不明(名の欄が番号)の場合は、姓が一致し、きっかけ(取得先)も同じ予約があれば同じ人とみなす
export function findDuplicate(entry, registrants) {
  const rep = entry.people[0];
  const nameUnknown = /^\d+$/.test(rep.mei);
  const ours = normKana(rep.sei + (nameUnknown ? "" : rep.mei));
  if (!ours) return null;
  for (const r of registrants) {
    const theirs = normKana(r.kana);
    if (theirs === ours) return r;
    if (nameUnknown && theirs.startsWith(ours) && r.keiyu === entry.keiyu.label) return r;
  }
  return null;
}
