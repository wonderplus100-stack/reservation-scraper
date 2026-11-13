// whitekeyへ入力する予約の「対象にするかどうか」のルール(ユーザー指定)。
//  1. 入力するのは、Wonder+公式サイトと、こくちーず(whitekey)の顧客、およびPeatixのうち下記のイベント種別のもの。
//  2. こくちーずには、ダミーの予約が入っている。同じ名前で予約が多数あるものはダミーなので、入力から除外する。
//  3. Peatixは、カフェ会系のイベント・朝活異業種交流会・レギュラー異業種交流会だけ入力する。それ以外のイベントには入力しない。
//  (4. 重複して入力しない仕組みは、whitekeyの既存の予約との照合として、scripts/whitekey-sync.mjs 側にある)

// 公式イベント名の「Wonder+○○」のシリーズ名から、イベント種別を判定する。
// 例: 「Wonder+CafeBiz」=カフェ会系、「Wonder+MorningBiz」=朝活異業種交流会、「Wonder+Business」=レギュラー異業種交流会
export function seriesOf(eventName) {
  const match = String(eventName || "").match(/Wonder[+＋]\s*([A-Za-z0-9&]+)/i);
  return match ? match[1] : "";
}

export function peatixCategoryOf(eventName) {
  const series = seriesOf(eventName).toLowerCase();
  // カフェ会系: CafeBiz(お昼) / EveningUP(夜カフェ会形式) / WomensCafe・WomenCafe(女子限定) / HolidayCafeStyleBIZ(休日) / 100Caf など「Caf」を含むもの
  if (/caf/.test(series) || series === "eveningup") return "カフェ会系";
  if (series === "morningbiz") return "朝活異業種交流会";
  if (series === "business") return "レギュラー異業種交流会";
  return "";
}

// ダミー判定: こくちーずで、同じ名前の予約が minCount 件以上あれば、ダミー(例: 「wonder+」「ワンダー」)。
// 入力するかどうかの判断なので、キャンセル済みの予約は数えない。名前は正規化(normalizedName)で比べる。
export function findDummyNames(rawRows, minCount) {
  const counts = new Map();
  for (const row of rawRows) {
    if (row.platform !== "kokuchpro" || /キャンセル/.test(row.bookingStatus || "")) continue;
    const key = String(row.normalizedName || row.reservationName || "").trim();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= minCount).map(([name]) => name));
}

export const DUMMY_MIN_COUNT = Number(process.env.WHITEKEY_DUMMY_MIN_COUNT) || 3;
// ステータスから「入力しない予約」を判定する(キャンセル・払い戻しなど)。
export const INACTIVE_STATUS = /キャンセル|払い戻し|払戻|返金|無効|取消|不参加/; // 「不参加」はPeatixでチケットが取り消された状態
