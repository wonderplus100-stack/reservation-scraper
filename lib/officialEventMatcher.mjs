import { getVenueKey } from "./venues.mjs";

// 各媒体の生イベント名(自由記述)から、公式スケジュール(月/日/会場)の
// どのイベントに該当するかを推定する。完全一致ではなく、日付+会場の
// 組み合わせで突き合わせるベストエフォート方式。

// "6/22" "6月22日" のような表記から月日を取り出す。
function extractMonthDay(text) {
  const value = String(text || "");
  // 「2026年11月30日」のように年つきで書かれた日付があれば、それを使う(開催日を表す確かな書き方)。
  const withYear = value.match(/\d{4}年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (withYear && Number(withYear[1]) >= 1 && Number(withYear[1]) <= 12 && Number(withYear[2]) >= 1 && Number(withYear[2]) <= 31) {
    return { month: Number(withYear[1]), day: Number(withYear[2]) };
  }
  // 「【14:00/15:00/18:50】」の「00/15」のような時刻の並びを日付と読み違えないよう、最初の有効な月日を採る。
  for (const m of value.matchAll(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day };
  }
  return null;
}

// "19:30" のような開始時刻を取り出す(候補が複数ある場合の絞り込み用)。
function extractStartTime(text) {
  // 「【14:00/15:00/18:50】…2026年11月30日(月) 15:00〜16:30」のように時刻が複数書かれたタイトルでは、
  // 先頭の時刻は別の回の時刻。その回の開始時刻は、日付(曜日)の直後に書かれている。
  const afterDate = String(text || "").match(/\d{1,2}\s*月\s*\d{1,2}\s*日\s*[（(][日月火水木金土][）)]\s*(\d{1,2}):(\d{2})/);
  if (afterDate) return `${afterDate[1].padStart(2, "0")}:${afterDate[2]}`;
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

// 自動投稿ツールが記録している「開始日時(月・日・開始時刻)+タイトル」から
// 公式イベントを特定する。生イベント名の曖昧な文章解析と違い、日付と
// 開始時刻が構造化された値で手に入るので、一致条件を厳しくできる:
// 開始時刻まで完全一致する公式イベントだけを候補とし、会場がタイトルに
// 含まれていれば会場も一致を必須にする。それでも1件に絞れない場合は
// 推測せずnull(=人が「未紐づけ」画面で確定する)。
export function matchOfficialEventByStart({ month, day, time, title }, officialEvents) {
  let candidates = officialEvents.filter(
    (event) => Number(event.month) === month && Number(event.day) === day && event.time === time
  );
  if (candidates.length === 0) return null;
  const venueKey = getVenueKey(title);
  if (venueKey) {
    candidates = candidates.filter((event) => event.venueKey === venueKey);
    if (candidates.length === 0) return null;
  }
  if (candidates.length === 1) return candidates[0];
  const bySeries = candidates.filter((event) => isSameSeries(title, event.canonicalEventName));
  return bySeries.length === 1 ? bySeries[0] : null;
}

// "10月16日（木）" のように曜日が添えられている場合、その曜日が今年の暦と
// 合わず、去年の暦なら合うときは「去年の開催回」とみなす。Googleフォームの
// 選択肢には年が書かれておらず、去年の選択肢の回答が残っていると、月日+会場が
// たまたま一致する今年のイベントに混入して人数が水増しされるため
// (2026年10/16は金曜だが、フォームの文言は「（木）」=2025年の暦、など)。
// 年末年始に直近の12月分まで弾かないよう、去年の該当日が60日以上前の場合に限る。
export function isOldYearByWeekday(text, now = new Date()) {
  const match = String(text || "").match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*[（(]([日月火水木金土])[）)]/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const weekday = "日月火水木金土".indexOf(match[3]);
  const year = now.getFullYear();
  const thisYear = new Date(year, month - 1, day);
  const lastYear = new Date(year - 1, month - 1, day);
  if (thisYear.getDay() === weekday) return false;
  if (lastYear.getDay() !== weekday) return false;
  return now - lastYear > 60 * 24 * 60 * 60 * 1000;
}

// 会場名の記載が無い「…（木）20:00 – 21:00」のような1時間枠は、毎週木曜夜の
// オンライン異業種交流会(Googleフォーム2の選択肢)。会場を持つ木曜20時の
// イベント(銀座Entertainmentは20:00〜22:00)と混同しないよう、20:00-21:00の
// 1時間枠に限る。
function inferOnlineVenueKey(text) {
  const value = String(text || "");
  return /[（(]木[）)]/.test(value) && /20:00\s*[–\-〜～~]\s*21:00/.test(value) ? "オンライン" : "";
}

// Peatix等のタイトルは、シリーズ名ではなく呼び名で書かれていることがある
// (例: 「飲み友会」=夜の交流会EveningUP、「カフェ会」=昼のカフェ会、「女性限定」=WomensCafe)。
// その呼び名から、公式シリーズ名として考えられるものの条件(正規表現)を返す。
function inferSeriesHints(text) {
  const value = String(text || "");
  if (/飲み友会|夜のカフェ|夜の部|仕事帰り/.test(value)) return [/^eveningup$/];
  if (/女性限定|女子会/.test(value)) return [/^womens?cafe$/];
  // 他社(Enjoy Japan)の掲載は、シリーズ名ではなく「〜業界」のテーマで書かれている。
  if (/不動産/.test(value)) return [/^realestate$/];
  if (/美容|健康/.test(value)) return [/^beauty$/];
  if (/人材/.test(value)) return [/^hr$/];
  if (/SES|システムエンジニア/.test(value)) return [/^ses$/];
  if (/昼のカフェ|休日のカフェ|カフェ会|ミニスイーツ/.test(value)) return [/caf/];
  return [];
}

function seriesTokenOfOfficial(event) {
  return String(extractSeriesToken(event.canonicalEventName) || "").toLowerCase();
}

// 候補を、タイトルの呼び名(inferSeriesHints)で絞り込む。絞り込みで0件になるなら元の候補のまま返す。
function narrowByHints(rawEventName, candidates) {
  const hints = inferSeriesHints(rawEventName);
  if (hints.length === 0) return candidates;
  const narrowed = candidates.filter((event) => hints.some((rx) => rx.test(seriesTokenOfOfficial(event))));
  return narrowed.length > 0 ? narrowed : candidates;
}

// 会場の記載が無いタイトル(Peatixの「…Wonder＋EveningUP｜11月10日」など)用。
// 日付が一致し、シリーズ名(または呼び名)が一致する公式イベントが1つだけなら、それを返す。
function matchWithoutVenue(rawEventName, monthDay, officialEvents) {
  const sameDay = officialEvents.filter((event) => Number(event.month) === monthDay.month && Number(event.day) === monthDay.day);
  let candidates = sameDay.filter((event) => isSameSeries(rawEventName, event.canonicalEventName));
  if (candidates.length === 0) {
    const hints = inferSeriesHints(rawEventName);
    if (hints.length > 0) candidates = sameDay.filter((event) => hints.some((rx) => rx.test(seriesTokenOfOfficial(event))));
  }
  if (candidates.length > 1) {
    const startTime = extractStartTime(rawEventName);
    if (startTime) {
      const byTime = candidates.filter((event) => String(event.time || "").startsWith(startTime));
      if (byTime.length === 1) return byTime[0];
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// rawEventNameを公式イベント一覧(officialEvents)と突き合わせ、
// 一致するものがあればそのエントリを返す(無ければnull)。
export function matchOfficialEvent(rawEventName, officialEvents) {
  const found = matchOfficialEventRaw(rawEventName, officialEvents);
  return found && isPlausibleMapping(rawEventName, found) ? found : null;
}

function matchOfficialEventRaw(rawEventName, officialEvents) {
  const monthDay = extractMonthDay(rawEventName);
  if (!monthDay) return null;
  const venueKey = getVenueKey(rawEventName) || inferOnlineVenueKey(rawEventName);
  if (!venueKey) {
    const year = extractYear(rawEventName);
    if (year && year !== new Date().getFullYear()) return null;
    return matchWithoutVenue(rawEventName, monthDay, officialEvents);
  }

  // 年の記載があり、かつ今年ではない場合は別回の開催として扱い、
  // 突き合わせ自体を諦める。年の記載が無くても、曜日が去年の暦と合う場合は同様。
  const year = extractYear(rawEventName);
  if (year && year !== new Date().getFullYear()) return null;
  if (isOldYearByWeekday(rawEventName)) return null;

  const candidates = officialEvents.filter(
    (event) => Number(event.month) === monthDay.month && Number(event.day) === monthDay.day && event.venueKey === venueKey
  );
  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    // 同じ日・同じ会場で複数の開催回がある場合、まずシリーズ名で絞り込む。
    const seriesMatches = candidates.filter((event) => isSameSeries(rawEventName, event.canonicalEventName));
    if (seriesMatches.length === 1) return seriesMatches[0];
    if (seriesMatches.length > 1) {
      const startTime = extractStartTime(rawEventName);
      if (startTime) {
        const byTime = seriesMatches.find((event) => String(event.time || "").startsWith(startTime));
        if (byTime) return byTime;
      }
      return seriesMatches[0];
    }
    // シリーズ名で絞り込めない場合は、まずタイトルに書かれた開始時刻で絞り込む。時刻は「〜19:00〜20:00」のように
    // 書かれた確かな情報なので、呼び名より優先する(呼び名を先に使うと、日曜の「夜の部『…カフェ会Style交流会』」が
    // 「カフェ会」の呼び名で昼のCafeBiz(13:30)に誤って紐づいた: 2026-11-15 whitekeyとの突き合わせで発覚)。
    const startTime = extractStartTime(rawEventName);
    if (startTime) {
      const byTime = candidates.filter((event) => String(event.time || "").startsWith(startTime));
      if (byTime.length === 1) return byTime[0];
    }
    // 時刻で決まらない場合は、タイトルの呼び名(「飲み友会」「カフェ会」等)で絞り込む。
    const byHints = narrowByHints(rawEventName, candidates);
    if (byHints.length === 1) return byHints[0];
    // 呼び名で複数に絞られた場合(「カフェ会」が CafeBiz と WomensCafe の両方に当たる等)は、その中で開始時刻で決める。
    if (startTime && byHints.length > 1) {
      const hintedByTime = byHints.filter((event) => String(event.time || "").startsWith(startTime));
      if (hintedByTime.length === 1) return hintedByTime[0];
    }
    // 時刻でもシリーズ名でも一意に絞り込めない場合、誤って別イベントに
    // 紐付けるよりは未マッピングのままにしておく方が安全なため、
    // 推測で先頭候補を返すことはしない。
    return null;
  }

  // 候補が1つしか無い場合でも、それだけで無条件に信用してはいけない。
  // 生テキストに紛れようのない明確なシリーズ名の記載があり、それが
  // 唯一の候補とはっきり食い違う場合は、日付+会場が偶然一致しただけの
  // 全く別シリーズの可能性が高いため、誤って紐付けるより未マッピングの
  // ままにする(実際に10/2銀座の唯一の候補がBusinessしか無い状況で、
  // 全く別の「Wonder+Lady100」シリーズの予約14件がBusinessの人数として
  // 誤集計されていた事故で発覚。Lady100は現在の公式サイトのどこにも
  // 存在しないシリーズで、日付+会場が偶然一致しただけだった)。
  // ただし次のようなトークンは判定材料として使わない(誤棄却を防ぐため):
  //  - "100"のような数字だけの、どの媒体にも頻出する曖昧なトークン
  //  - "Wonder+YOKOHAMA"のように、シリーズ名ではなく会場名をそのまま
  //    書いているだけのもの(venueKeyと一致する場合はシリーズ名扱いしない)
  const sole = candidates[0];
  const rawToken = extractSeriesToken(rawEventName);
  const isDistinctiveToken = rawToken && rawToken.length >= 4 && !/^[0-9]+$/.test(rawToken) && getVenueKey(rawToken) !== venueKey;
  if (isDistinctiveToken && !isSameSeries(rawEventName, sole.canonicalEventName)) {
    return null;
  }
  return sole;
}

// ---- 紐づけの妥当性の確認(2026-11-21 追加) ----
// 媒体のイベントを公式イベントに紐づけた結果が「あり得る」かを確かめる。次のどちらかなら、紐づけてはいけない:
//  ・題名が恋愛・合コン・婚活・街コンのイベント(Wonder+ではない。同じ日・同じ都市に公式イベントが1つだけの時、そこに紐づいてしまい、
//   2026-11-21 大阪の「100人合コン(19:30〜)」の予約者が、10:00のMorningBizの一覧に入った)
//  ・題名に書かれた開催日の直後の開始時刻が、公式イベントの開始時刻と3時間を超えてずれている(別の回の予約)
//   (3時間までは許す: 祝日だけ開始が早い「平日13:00・土祝11:00」のような回がある)
const DATING_TITLE = /合コン|恋愛|恋活|婚活|街コン/;
const MAX_TIME_GAP_MINUTES = 180;

export function titleStartMinutes(title) {
  const m = String(title || "").match(/\d{1,2}\s*月\s*\d{1,2}\s*日\s*[（(][日月火水木金土][）)]\s*(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isPlausibleMapping(rawEventName, event) {
  const title = String(rawEventName || "");
  if (DATING_TITLE.test(title)) return false;
  const start = titleStartMinutes(title);
  const eventTime = String((event && event.time) || "").match(/(\d{1,2}):(\d{2})/);
  if (start === null || !eventTime) return true;
  return Math.abs(start - (Number(eventTime[1]) * 60 + Number(eventTime[2]))) <= MAX_TIME_GAP_MINUTES;
}
