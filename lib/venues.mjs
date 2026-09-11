// wonder-plus-portal/tools/build-portal-caches.mjs の会場エイリアス表を流用。
// 公式スケジュール表(会場列)と各媒体の生イベント名(自由記述の会場名/英語表記)を
// 突き合わせるために使う。

export const VENUES = [
  ["北九州", "小倉", "kitakyushu", "kitakyusyu", "kokura"],
  ["福岡", "博多", "fukuoka", "hakata"],
  ["熊本", "kumamoto"],
  ["銀座", "ginza"],
  ["新宿", "shinjuku"],
  ["名古屋", "nagoya"],
  ["大阪", "osaka"],
  ["岡山", "okayama"],
  ["広島", "hiroshima"],
  ["京都", "kyoto"],
  ["神戸", "kobe"],
  ["横浜", "yokohama"],
  ["船橋", "funabashi"],
  ["千葉", "chiba"],
  ["仙台", "sendai"],
  ["郡山", "koriyama"],
  ["福島", "fukushima", "fukushim"],
  ["金沢", "kanazawa"],
  ["新潟", "niigata"],
  ["浜松", "hamamatsu"],
  ["久留米", "kurume"],
  ["前橋", "maebashi"],
  ["高崎", "takasaki", "labi"],
  ["静岡", "shizuoka"],
  ["札幌", "sapporo", "saporo"],
  ["宇都宮", "utsunomiya", "utunomiya"],
  ["町田", "machida"],
  ["甲府", "kofu"],
  ["大宮", "omiya"]
];

function normalizeForVenue(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function findVenueKeys(...values) {
  const text = normalizeForVenue(values.join(" "));
  return VENUES
    .filter((aliases) => aliases.some((alias) => text.includes(normalizeForVenue(alias))))
    .map((aliases) => aliases[0]);
}

export function getVenueKey(...values) {
  const matches = findVenueKeys(...values);
  if (matches.includes("高崎")) return "高崎";
  if (matches.includes("前橋")) return "前橋";
  return matches[0] || "";
}
