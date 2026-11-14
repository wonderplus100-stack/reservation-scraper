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

// event: 公式イベント({ canonicalEventName, venue })。種別が入力対象なら名前を、対象外なら空文字を返す。
// レギュラー異業種交流会(Business)は、名古屋と大阪では入力しない(ユーザー指定)。
const BUSINESS_EXCLUDED_VENUES = ["名古屋", "大阪"];
export function peatixCategoryOf(event) {
  const series = seriesOf(event && event.canonicalEventName).toLowerCase();
  // カフェ会系: CafeBiz(お昼) / EveningUP(夜カフェ会形式) / WomensCafe・WomenCafe(女子限定) / HolidayCafeStyleBIZ(休日) / 100Caf など「Caf」を含むもの
  if (/caf/.test(series) || series === "eveningup") return "カフェ会系";
  if (series === "morningbiz") return "朝活異業種交流会";
  if (series === "business") return BUSINESS_EXCLUDED_VENUES.includes(String(event.venue || "")) ? "" : "レギュラー異業種交流会";
  return "";
}

// ダミー判定(こくちーずの予約)。
//  実際のダミーは「1ウィルコム」「うぃるこむ 2」「8ホワイトキー」「ウィルコミュニケーションズ」のように、
//  社名・店名を名前にした予約。そこで、名前に次の文字が含まれるものをダミーとする(ユーザー指定の例から)。
//   ウィル/ウイル/うぃる/ホワイトキー/whitekey/wonder/ワンダー、および数字・記号だけの名前。
//  「同じ名前が何件以上」という件数の判定は、毎週参加するリピートのお客様まで除外してしまうため、
//  既定では使わない(.env の WHITEKEY_DUMMY_MIN_COUNT に数を入れた時だけ、追加で使う)。
// Apps Script側(dashboard/Code.js の isDummyName_)にも同じ判定がある。変える時は両方そろえること。
const DUMMY_NAME_PATTERN = /ウィル|ウイル|うぃる|ういる|ホワイトキー|ほわいとき|ﾎﾜｲﾄｷｰ|whitekey|wonder|ワンダー|他団体|多団体/i;
const SYMBOL_ONLY_PATTERN = /^[\d\s\-_.・★☆※]+$/;

export function isDummyName(name) {
  const text = String(name || "").normalize("NFKC").trim();
  if (!text) return false;
  return DUMMY_NAME_PATTERN.test(text) || SYMBOL_ONLY_PATTERN.test(text);
}

// 予約一覧から外す個人(ユーザー指定)。媒体を問わず、名簿・自動入力の両方から除く。空白を除いて比べる。
// 2026-11-14: 高杉裕輔(漢字・ローマ字・カナの表記ゆれを含む)
const EXCLUDED_PERSON_PATTERN = /高杉裕輔|タカスギユウスケ|たかすぎゆうすけ|yusuketakasugi|takasugiyusuke/i;
export function isExcludedPerson(name) {
  const text = String(name || "").normalize("NFKC").replace(/\s/g, "");
  return Boolean(text) && EXCLUDED_PERSON_PATTERN.test(text);
}

// whitekeyに入れる姓の前に付ける、媒体の頭文字(ユーザー指定)。
//  PeatixのWonder+=P / PeatixのJua Party=JP / こくちーずのEnjoy Japan=EJ / EVEMADO=EM /
//  フォーム・LP・SNS・こくちーずのWonder+=WP。Wonder+公式サイト・こくちーず(Whitekey)は付けない(指定なし)。
export function mediaPrefix(platform, account) {
  const acc = String(account || "");
  if (platform === "peatix") return /jua/i.test(acc) ? "JP" : "P";
  if (platform === "kokuchpro") {
    if (/enjoy/i.test(acc)) return "EJ";
    if (/whitekey/i.test(acc)) return "";
    return "WP";
  }
  if (platform === "evemado") return "EM";
  if (platform === "googleForms") return "WP";
  return "";
}

// ダミーと判定する名前の一覧(名前の文字による判定に加え、minCount が1以上なら「同じ名前が minCount 件以上」も加える)。
// 入力するかどうかの判断なので、キャンセル済みの予約は件数に数えない。名前は正規化(normalizedName)で比べる。
export function findDummyNames(rawRows, minCount = 0) {
  const counts = new Map();
  const dummy = new Set();
  for (const row of rawRows) {
    if (row.platform !== "kokuchpro") continue;
    const key = String(row.normalizedName || row.reservationName || "").trim();
    if (!key) continue;
    if (isDummyName(row.reservationName) || isDummyName(key)) dummy.add(key);
    if (!/キャンセル/.test(row.bookingStatus || "")) counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (minCount > 0) for (const [name, n] of counts) if (n >= minCount) dummy.add(name);
  return dummy;
}

export const DUMMY_MIN_COUNT = Number(process.env.WHITEKEY_DUMMY_MIN_COUNT) || 0;
// ステータスから「入力しない予約」を判定する(キャンセル・払い戻しなど)。
export const INACTIVE_STATUS = /キャンセル|払い戻し|払戻|返金|無効|取消|不参加/; // 「不参加」はPeatixでチケットが取り消された状態

// whitekeyへ入力するこくちーずは、「Whitekey」のアカウントだけ(Wonder+自身・Enjoy Japanのこくちーずは入力しない)。
// アカウント名に含まれる文字は、.env の WHITEKEY_KOKUCHPRO_ACCOUNT_PATTERN(正規表現)で変えられる。
// (2026-11-14: Enjoy Japan のこくちーずも、Whitekeyと同じ扱いにするようユーザーから指示)
export function isWhitekeyKokuchproAccount(account) {
  return new RegExp(process.env.WHITEKEY_KOKUCHPRO_ACCOUNT_PATTERN || "whitekey|enjoy", "i").test(String(account || ""));
}

// 名前の終わりの字から、女性らしい名前かを推定する(媒体に性別の情報が無い予約用)。
//  実データ(性別が分かっている約1,400人)で試したところ、女性と推定した人の98%が実際に女性だった。
//  ただし女性の約4割は見分けられない(推定できない=不明のまま)。男性と推定することはしない。
// Apps Script側(dashboard/Code.js の guessFemaleFromName_)にも同じ規則がある。変える時は両方そろえること。
const FEMALE_KANJI_END = /[子美香奈菜花恵絵梨彩咲乃衣織瑠莉穂萌凛華楓桜紗里代沙愛佳理江枝那苗]$/;
const FEMALE_KANA_END = /[こみかなえりほよね]$/;
export function guessFemaleFromName(name) {
  const text = String(name || "")
    .normalize("NFKC")
    .replace(/\(同行\d+\)$/, "")
    .replace(/[★☆\s]/g, "");
  if (!text || /^[A-Za-z.'-]+$/.test(text)) return false;
  if (/[ぁ-ん]/.test(text)) return FEMALE_KANA_END.test(text);
  return FEMALE_KANJI_END.test(text);
}

// 土曜の昼カフェ会は、公式サイトに「第1部」「第2部」「両方参加(通し)」の3イベントがある。
// こくちーずは1つのイベントにチケット(1部のみ/2部のみ/両方参加)が並ぶので、チケット名でどの部かを判定する。
// Apps Script側(dashboard/Code.js の slotPartOf_ / ticketPartOf_)にも同じ判定がある。変える時は両方そろえること。
export function slotPartOf(eventName) {
  const text = String(eventName || "");
  if (/両方|セット|通し/.test(text)) return "both";
  if (/第2部/.test(text)) return "p2";
  if (/第1部/.test(text)) return "p1";
  return "";
}
export function ticketPartOf(ticketName) {
  const text = String(ticketName || "");
  if (/両方|セット/.test(text)) return "both";
  if (/2部のみ/.test(text)) return "p2";
  if (/1部のみ/.test(text)) return "p1";
  return "";
}
