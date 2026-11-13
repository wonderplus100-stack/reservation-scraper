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

// 一致するパーティーを返す。{ party, state }  state: 一致 / whitekeyにパーティーなし / 候補が複数
export function matchParty(entry, parties) {
  // whitekeyには婚活パーティーやホワイトマリッジの相談会も並ぶ。ホワイトマリッジは除き、同じ都市・時刻に
  // 複数ある場合は、タイトルに「Wonder+」を含むもの、さらに公式イベント名のシリーズ名(Business・Gravity 等)で絞る。
  let candidates = parties.filter(
    (p) => p.city === entry.venue && p.start === startTime(entry.time) && p.hasReceptionButton && !p.hall.includes("ホワイトマリッジ")
  );
  if (candidates.length > 1) {
    const wonder = candidates.filter((p) => /Wonder[+＋]/i.test(p.title));
    if (wonder.length >= 1) candidates = wonder;
  }
  if (candidates.length > 1) {
    const series = (entry.eventName.match(/Wonder[+＋]\s*([A-Za-z0-9]+)/i) || [])[1]?.toLowerCase();
    const narrowed = series ? candidates.filter((p) => p.title.toLowerCase().includes(series)) : [];
    if (narrowed.length >= 1) candidates = narrowed;
  }
  if (candidates.length === 1) return { party: candidates[0], state: "一致", candidates };
  return { party: null, state: candidates.length === 0 ? "whitekeyにパーティーなし" : "候補が複数", candidates };
}
