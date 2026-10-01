import { getVenueKey } from "./venues.mjs";

// 各媒体の生イベント名(自由記述)から、公式スケジュール(月/日/会場)の
// どのイベントに該当するかを推定する。完全一致ではなく、日付+会場の
// 組み合わせで突き合わせるベストエフォート方式。

// "6/22" "6月22日" のような表記から月日を取り出す。
function extractMonthDay(text) {
  const value = String(text || "");
  const slashMatch = value.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
  if (!slashMatch) return null;
  const month = Number(slashMatch[1]);
  const day = Number(slashMatch[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

// "19:30" のような開始時刻を取り出す(候補が複数ある場合の絞り込み用)。
function extractStartTime(text) {
  const match = String(text || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

// "Wonder+Freelance" "Wonder+ CXO" のようなシリーズ名トークンを取り出す。
// 同じ日・同じ会場に複数の開催回がある場合、時刻の記載が無い媒体の
// テキストでは絞り込めないため、代わりにこのシリーズ名が一致するかで
// 絞り込む(例: 10/1 銀座にBusiness/Story/Freelanceの3回がある状況で、
// Peatix側の生テキストに時刻が無かったため先頭候補のStoryに誤って
// 紐付いてしまい、本来のFreelanceの予約が反映されなかった事故で発覚)。
function extractSeriesToken(text) {
  const match = String(text || "").match(/Wonder[+＋]\s*([A-Za-z0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// ジモティーの投稿タイトルは「夜カフェ会Style 新宿 EveningUP」のように
// シリーズ名が"Wonder+"を伴わずそのまま書かれることがある(実アカウントで
// 確認済み)。その場合は上のextractSeriesTokenでは拾えないため、公式側の
// シリーズ名トークンが生テキストに単語境界つきでそのまま含まれるかも
// 追加でチェックする。ただし"100"のような極端に短い/数字だけのトークンは
// 無関係な文脈(人数表記等)に偶然含まれるだけで誤一致しやすいため対象外。
function rawTextContainsSeriesToken(rawEventName, token) {
  if (!token || token.length < 4 || /^[0-9]+$/.test(token)) return false;
  return new RegExp(`\\b${token}\\b`, "i").test(String(rawEventName || ""));
}

// "Lady"/"Ladies"のような単数形・複数形のゆれは別トークン扱いだと
// 一致しなくなってしまうため、前方一致に加えて英語の複数形("y"→"ies"の
// 不規則変化を含む)も同じシリーズとみなす。
function pluralize(word) {
  return word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`;
}

function tokensMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return pluralize(a) === b || pluralize(b) === a;
}

function isSameSeries(rawEventName, canonicalEventName) {
  const officialToken = extractSeriesToken(canonicalEventName);
  if (!officialToken) return false;
  const rawToken = extractSeriesToken(rawEventName);
  if (rawToken && tokensMatch(rawToken, officialToken)) return true;
  return rawTextContainsSeriesToken(rawEventName, officialToken);
}

// "2025年9月30日" のような表記から年を取り出す。こくちーずPROの「終了
// イベント」一覧は年をまたいだ過去の開催回もずっと残るため、年の記載が
// あるのにそれを見ずに月日+会場だけで突き合わせると、去年以前の別回の
// 申込みが今年の同日同会場イベントに誤って混入してしまう
// (実際に2025年9月30日の別イベントの申込みが2026年9月30日のWonder+CXOに
// 混入していた事故で発覚)。
function extractYear(text) {
  const match = String(text || "").match(/(\d{4})年/);
  return match ? Number(match[1]) : null;
}

// rawEventNameを公式イベント一覧(officialEvents)と突き合わせ、
// 一致するものがあればそのエントリを返す(無ければnull)。
export function matchOfficialEvent(rawEventName, officialEvents) {
  const monthDay = extractMonthDay(rawEventName);
  if (!monthDay) return null;
  const venueKey = getVenueKey(rawEventName);
  if (!venueKey) return null;

  // 年の記載があり、かつ今年ではない場合は別回の開催として扱い、
  // 突き合わせ自体を諦める(年の記載が無い媒体の表記は従来どおり許容する)。
  const year = extractYear(rawEventName);
  if (year && year !== new Date().getFullYear()) return null;

  const candidates = officialEvents.filter(
    (event) => Number(event.month) === monthDay.month && Number(event.day) === monthDay.day && event.venueKey === venueKey
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 同じ日・同じ会場で複数の開催回がある場合、まず開始時刻で絞り込む。
  const startTime = extractStartTime(rawEventName);
  if (startTime) {
    const byTime = candidates.filter((event) => String(event.time || "").startsWith(startTime));
    if (byTime.length === 1) return byTime[0];
    if (byTime.length > 1) {
      return byTime.find((event) => isSameSeries(rawEventName, event.canonicalEventName)) || null;
    }
  }

  // 時刻の記載が無い(またはどの候補とも一致しない)場合は、
  // "Wonder+XXXX"のシリーズ名が一致する候補を探す。
  const bySeries = candidates.find((event) => isSameSeries(rawEventName, event.canonicalEventName));
  if (bySeries) return bySeries;

  // 時刻でもシリーズ名でも一意に絞り込めない場合、誤って別イベントに
  // 紐付けるよりは未マッピングのままにしておく方が安全なため、
  // 推測で先頭候補を返すことはしない。
  return null;
}
