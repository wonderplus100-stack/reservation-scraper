// Wonder+ 集客状況ダッシュボード(表示 + 名簿書き出し)
//
// データ元は wonder-plus-reservation-scraper が書き込む非公開スプレッドシート。
// 顧客氏名という個人情報を扱うため、Webアプリのデプロイ設定は
// 「リンクを知っている人のみ閲覧可(ログイン不要)」を想定している
// (Apps Scriptエディタの「デプロイを管理」>「アクセスできるユーザー」を
// "全員" に設定。検索エンジンには載らず、URLを知らない第三者からは
// 到達できない)。氏名を完全に一般公開する設定ではない点に注意。
//
// 匿名アクセスになるため Session.getActiveUser().getEmail() は基本的に
// 空になる。ALLOWED_VIEWERS を設定しない限り isAuthorized_ は常に true を
// 返す(=リンクを知っていれば誰でも閲覧・書き出しができる)設計。

const SHEET_ID_PROPERTY_KEY = "RESERVATION_SHEET_ID";
const RAW_DATA_SHEET = "RawData";
const EVENT_MASTER_SHEET = "EventMaster";
const OFFICIAL_EVENTS_SHEET = "OfficialEvents";
const PLATFORM_EVENT_MAP_SHEET = "PlatformEventMap";
const PLATFORM_EVENT_MAP_HEADERS = ["platform", "platformEventId", "officialEventId", "officialEventName", "title", "source", "updatedAt"];
const EVENT_MASTER_HEADERS = ["canonicalEventId", "canonicalEventName", "platform", "account", "rawEventName"];
const SOURCE_STATUS_SHEET = "SourceStatus";
const UPDATE_CONTROL_SHEET = "UpdateControl";
const UPDATE_CONTROL_HEADERS = ["status", "message", "requestedAt", "updatedAt"];

function getSheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROPERTY_KEY);
  if (!id) throw new Error(`スクリプトプロパティ ${SHEET_ID_PROPERTY_KEY} が未設定です`);
  return id;
}

function isAuthorized_() {
  // access:"MYSELF" の場合、そもそもここに到達する時点で所有者アカウントに
  // 限定されている。将来 access を広げた場合に備えた保険的チェック。
  const allowed = PropertiesService.getScriptProperties().getProperty("ALLOWED_VIEWERS");
  if (!allowed) return true;
  const email = Session.getActiveUser().getEmail();
  if (!email) return true; // 個人Gmailではメールが取得できないことがあるため、未設定時は許可扱い
  return allowed.split(",").map((s) => s.trim()).includes(email);
}

function readObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return [];
  const [headers, ...rows] = values;
  return rows
    .filter((row) => row.some((cell) => String(cell || "").trim()))
    .map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
}

function buildDashboardData_() {
  const ss = SpreadsheetApp.openById(getSheetId_());
  const rawRows = readObjects_(ss.getSheetByName(RAW_DATA_SHEET));
  const eventMaster = readObjects_(ss.getSheetByName(EVENT_MASTER_SHEET));
  const officialEventsSheet = ss.getSheetByName(OFFICIAL_EVENTS_SHEET);
  const officialEvents = officialEventsSheet ? readObjects_(officialEventsSheet) : [];

  const platformMapSheet = ss.getSheetByName(PLATFORM_EVENT_MAP_SHEET);
  const platformMapRows = platformMapSheet ? readObjects_(platformMapSheet) : [];

  const eventNameById = new Map(eventMaster.map((row) => [String(row.canonicalEventId), String(row.canonicalEventName || "")]));
  const officialIds = new Set(officialEvents.map((o) => String(o.canonicalEventId || "").trim()).filter(Boolean));
  const mapByKey = new Map(
    platformMapRows.map((r) => [`${r.platform}|||${r.platformEventId}`, String(r.officialEventId || "").trim()])
  );
  // ダッシュボードで人が紐づけた直後(次回のスクレイピング前)でも即座に
  // 反映されるよう、RawDataに保存済みのcanonicalEventIdだけに頼らず、
  // 読み取り時にも「媒体のイベントID」「EventMaster」の対応表を引き直す。
  const masterLookup = new Map(
    eventMaster.map((r) => [
      `${r.platform}|||${r.account}|||${String(r.rawEventName || "").trim()}`,
      String(r.canonicalEventId || "").trim()
    ])
  );

  // 公式イベントに紐づいた行の公式イベントIDを返す。紐づいていなければnull。
  function resolveOfficialId_(row) {
    if (row.platformEventId) {
      const mapped = mapByKey.get(`${row.platform}|||${row.platformEventId}`);
      if (mapped && officialIds.has(mapped)) return mapped;
    }
    const own = String(row.canonicalEventId || "").trim();
    if (own && officialIds.has(own)) return own;
    const viaMaster = masterLookup.get(`${row.platform}|||${row.account}|||${String(row.rawEventName || "").trim()}`);
    if (viaMaster && officialIds.has(viaMaster)) return viaMaster;
    return null;
  }

  function newGroup_(base) {
    return {
      ...base,
      sourceCounts: new Map(), // "platform/account" -> 件数(重複含む生の件数)
      referrerCounts: new Map(), // 担当者/紹介者名 -> 件数(値がある行のみ)
      uniqueNames: new Map(), // normalizedName -> {name, katakana, referrer, source}
      latestObtainedAt: ""
    };
  }

  function accumulateRow_(group, row) {
    const sourceKey = `${row.platform}/${row.account}`;
    group.sourceCounts.set(sourceKey, (group.sourceCounts.get(sourceKey) || 0) + 1);
    const referrerName = String(row.referrerName || "").trim();
    if (referrerName) {
      group.referrerCounts.set(referrerName, (group.referrerCounts.get(referrerName) || 0) + 1);
    }
    const normalizedName = String(row.normalizedName || "").trim();
    // 同じ人が複数の取得元に出る場合に備え、その人が出ている取得元を全て覚える
    // (画面の「Whitekey / Wonder+ / 全体」の切り替えで、取得元の区分ごとに数え直すため)。
    const existing = normalizedName ? group.uniqueNames.get(normalizedName) : null;
    if (existing && existing.sources.indexOf(sourceKey) === -1) existing.sources.push(sourceKey);
    if (normalizedName && !existing) {
      const name = String(row.reservationName || "").trim();
      // カタカナ表記: ふりがな列からの変換値があればそれを使い、なければ
      // (Googleフォーム以外など、ふりがな情報が無い媒体)元の氏名表記のまま。
      const katakana = String(row.readingKatakana || "").trim() || name;
      // 金額と性別(媒体のチケット名・性別欄から判断。分からない時は空)。
      // 自動入力で男女を判定する時と同じ考え方で表示する(分からなければ男性として入力される)。
      const amount = parseAmount_(row.amount);
      group.uniqueNames.set(normalizedName, {
        name, katakana, referrer: referrerName, source: sourceKey, sources: [sourceKey],
        amount, gender: judgeGender_(row)
      });
    } else if (existing) {
      // 同じ人の別の行に金額・性別があれば補う
      if (existing.amount === null || existing.amount === undefined) existing.amount = parseAmount_(row.amount);
      if (!existing.gender) existing.gender = judgeGender_(row);
    }
    if (String(row.obtainedAt || "") > group.latestObtainedAt) {
      group.latestObtainedAt = String(row.obtainedAt || "");
    }
  }

  // 主一覧(最新/過去)は、Wonder+公式サイトのイベント(OfficialEvents)だけにする。
  // 予約がまだ1件も無いイベントもプルダウンに出せるよう先に空の枠を用意する。
  // 公式に紐づいていない予約は、別イベントとして一覧に混ぜず
  // 「未紐づけ」(紐づけ待ち)と「旧データ」に分けて扱う
  // (混ぜると同じイベントが重複して見えたり、人数が分散して見えるため)。
  const eventGroups = new Map();
  for (const official of officialEvents) {
    const eventId = String(official.canonicalEventId || "").trim();
    if (!eventId) continue;
    eventGroups.set(
      eventId,
      newGroup_({
        eventId,
        eventName: String(official.canonicalEventName || eventId),
        month: Number(official.month) || null,
        day: Number(official.day) || null
      })
    );
  }

  const legacyGroups = new Map(); // 公式サイトに無い旧イベントID(旧スプレッドシート由来等)
  const unlinkedGroups = new Map(); // どの公式イベントにも紐づいていない予約

  for (const row of rawRows) {
    // こくちーずのダミー予約(社名などを名前にした確認用の予約)は、人数にも名簿にも入れない。
    // (元の媒体の予約には何もしない。表示から外すだけ)
    if (row.platform === "kokuchpro" && isDummyName_(row.reservationName)) continue;
    // 人が「対象外」と確定した予約は、集計にも未紐づけにも出さない。
    const mappedId = row.platformEventId ? mapByKey.get(`${row.platform}|||${row.platformEventId}`) : undefined;
    const masterId = masterLookup.get(`${row.platform}|||${row.account}|||${String(row.rawEventName || "").trim()}`);
    if (mappedId === IGNORE_EVENT_ID_ || masterId === IGNORE_EVENT_ID_) continue;

    const officialId = resolveOfficialId_(row);
    if (officialId) {
      accumulateRow_(eventGroups.get(officialId), row);
      continue;
    }
    const ownId = String(row.canonicalEventId || "").trim();
    if (ownId) {
      if (!legacyGroups.has(ownId)) {
        legacyGroups.set(ownId, newGroup_({ eventId: ownId, eventName: eventNameById.get(ownId) || ownId }));
      }
      accumulateRow_(legacyGroups.get(ownId), row);
      continue;
    }
    const key = [row.platform, row.account, row.platformEventId || row.rawEventName].join("|||");
    if (!unlinkedGroups.has(key)) {
      unlinkedGroups.set(
        key,
        newGroup_({
          platform: String(row.platform || ""),
          account: String(row.account || ""),
          platformEventId: String(row.platformEventId || ""),
          rawEventName: String(row.rawEventName || "")
        })
      );
    }
    accumulateRow_(unlinkedGroups.get(key), row);
  }

  // 会場名や日付の書式が媒体ごとにバラバラ(生テキストそのまま登録された
  // 旧来のEventMaster行が多いこと)なので、月日を取り出して表示用の
  // タイトルに整形しつつ、あわせて「最新(今日以降)」「過去(今日より前)」の
  // 2タブに分けるための日付判定も行う。
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const decorated = Array.from(eventGroups.values()).map((group) => {
    let month = group.month;
    let day = group.day;
    if (!month || !day) {
      const extracted = extractMonthDayFromText_(group.eventName);
      if (extracted) {
        month = extracted.month;
        day = extracted.day;
      }
    }
    return {
      eventId: group.eventId,
      displayName: formatEventTitle_(group.eventName, month, day),
      month,
      day,
      dateObj: resolveEventDate_(month, day),
      startMinutes: extractStartMinutes_(group.eventName),
      sourceCounts: Array.from(group.sourceCounts.entries()).map(([source, count]) => ({ source, count })),
      referrerCounts: Array.from(group.referrerCounts.entries()).map(([referrer, count]) => ({ referrer, count })),
      uniqueCount: group.uniqueNames.size,
      names: Array.from(group.uniqueNames.values()).sort((a, b) => a.name.localeCompare(b.name, "ja")),
      latestObtainedAt: group.latestObtainedAt
    };
  });

  const byDateAsc = (a, b) => a.dateObj - b.dateObj || (a.startMinutes ?? 0) - (b.startMinutes ?? 0);
  const byDateDesc = (a, b) => b.dateObj - a.dateObj || (a.startMinutes ?? 0) - (b.startMinutes ?? 0);

  // 最新(今日以降): 開催日が近い順。
  const upcomingEvents = decorated.filter((e) => e.dateObj && e.dateObj >= today).sort(byDateAsc);

  // 過去(今日より前): 直近(今日に近い)ものから順。日付が読み取れなかった
  // ごく一部のイベント(「調整中」等の空データ)は末尾に更新順で残す。
  const pastKnown = decorated.filter((e) => e.dateObj && e.dateObj < today).sort(byDateDesc);
  const pastUnknown = decorated
    .filter((e) => !e.dateObj)
    .sort((a, b) => b.latestObtainedAt.localeCompare(a.latestObtainedAt));

  // dateObjはDateオブジェクトのままだとgoogle.script.runのシリアライズで
  // 失敗し、成功ハンドラにnullが渡って画面が真っ白になる事故が起きたため、
  // ソートに使い終わったらクライアントに返す前に取り除く。
  const forClient = (list) =>
    list.map(({ dateObj, startMinutes, ...rest }) => rest);

  // 紐づけ先の候補を3段階で出す(同じ日・同じ会場 → 同じ日の他会場 → 前後3日)。
  // 日付と会場が両方一致するものだけだと、日付が1日ずれていたり会場名が
  // 書かれていない予約には候補がほとんど出ず、選べなくなってしまうため。
  const officialList = [];
  for (const group of eventGroups.values()) {
    if (!group.month || !group.day) continue;
    officialList.push({
      id: group.eventId,
      name: formatEventTitle_(group.eventName, group.month, group.day),
      venueKey: detectVenueKey_(group.eventName),
      startMinutes: extractStartMinutes_(group.eventName),
      dateKey: `${group.month}/${group.day}`,
      dateObj: resolveEventDate_(group.month, group.day)
    });
  }
  function candidatesFor_(dateKey, rawEventName) {
    const md = dateKey.split("/");
    const target = resolveEventDate_(Number(md[0]), Number(md[1]));
    if (!target) return [];
    const venueKey = detectVenueKey_(rawEventName);
    const byTime = (a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const sameDate = officialList.filter((c) => c.dateKey === dateKey);
    const sameVenue = venueKey ? sameDate.filter((c) => c.venueKey === venueKey).sort(byTime) : [];
    const sameVenueIds = new Set(sameVenue.map((c) => c.id));
    const otherVenue = sameDate.filter((c) => !sameVenueIds.has(c.id)).sort(byTime);
    const nearby = officialList
      .filter((c) => c.dateKey !== dateKey && c.dateObj && Math.abs(c.dateObj - target) <= 3 * DAY_MS)
      .filter((c) => !venueKey || c.venueKey === venueKey)
      .sort((a, b) => a.dateObj - b.dateObj || byTime(a, b));
    const tag = (list, group) => list.map(({ id, name }) => ({ id, name, group }));
    return [
      ...tag(sameVenue, "同じ日・同じ会場"),
      ...tag(otherVenue, venueKey && sameVenue.length ? "同じ日の他会場" : "同じ日"),
      ...tag(nearby, "前後3日(同じ会場)")
    ];
  }

  // 去年以前の年が明記されたもの(こくちーずの旧開催回等)や、45日より前に終わった
  // イベントは、いま紐づけても確認の意味が薄いため「紐づけ待ち」には数えず、
  // 件数だけ別に出す(バッジが古いデータで膨らむのを防ぐ)。
  const STALE_MS = 45 * 24 * 60 * 60 * 1000;
  const currentYear = today.getFullYear();
  let staleCount = 0;
  const unlinkedAll = Array.from(unlinkedGroups.values()).map((group) => {
    const md = extractMonthDayFromText_(group.rawEventName);
    const dateKey = md ? `${md.month}/${md.day}` : "";
    const dateObj = md ? resolveEventDate_(md.month, md.day) : null;
    const yearMatch = group.rawEventName.match(/(\d{4})年/);
    const explicitOldYear = yearMatch && Number(yearMatch[1]) !== currentYear;
    const stale = Boolean(
      explicitOldYear || isOldYearByWeekday_(group.rawEventName) || (dateObj && today - dateObj > STALE_MS)
    );
    return {
      stale,
      platform: group.platform,
      account: group.account,
      platformEventId: group.platformEventId,
      rawEventName: group.rawEventName.replace(/\s+/g, " ").trim(),
      dateKey,
      distance: dateObj ? Math.abs(dateObj - today) : Infinity,
      rawCount: Array.from(group.sourceCounts.values()).reduce((sum, n) => sum + n, 0),
      uniqueCount: group.uniqueNames.size,
      names: Array.from(group.uniqueNames.values())
        .sort((a, b) => a.name.localeCompare(b.name, "ja"))
        .slice(0, 12)
    };
  });
  // 今日に近い日付のものを先頭に(いま確認したい予約から順に)。
  unlinkedAll.sort((a, b) => (a.distance === b.distance ? 0 : a.distance < b.distance ? -1 : 1));
  const unlinkedActive = unlinkedAll.filter((g) => !g.stale);
  staleCount = unlinkedAll.length - unlinkedActive.length;
  const unlinked = unlinkedActive.slice(0, 120).map(({ distance, stale, ...rest }) => ({
    ...rest,
    candidates: rest.dateKey ? candidatesFor_(rest.dateKey, rest.rawEventName).slice(0, 40) : []
  }));

  // 旧データ: 公式サイトに存在しない旧イベントID(旧スプレッドシート由来や、
  // 公式サイトが掲載を終了した過去イベント)。参照用に件数だけ出す。
  const legacy = Array.from(legacyGroups.values())
    .map((group) => {
      const md = extractMonthDayFromText_(group.eventName);
      return {
        eventId: group.eventId,
        title: formatEventTitle_(group.eventName, md && md.month, md && md.day),
        uniqueCount: group.uniqueNames.size,
        sortKey: md ? md.month * 100 + md.day : 0
      };
    })
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, 300)
    .map(({ sortKey, ...rest }) => rest);

  return {
    updatedAt: new Date().toISOString(),
    sources: readSourceStatus_(ss),
    whitekeyPending: readWhitekeyPending_(ss),
    upcomingEvents: forClient(upcomingEvents),
    pastEvents: forClient([...pastKnown, ...pastUnknown]),
    unlinked,
    unlinkedTotal: unlinkedActive.length,
    unlinkedStaleTotal: staleCount,
    legacy,
    legacyTotal: legacyGroups.size
  };
}

// スクレイパーが書き出す SourceStatus(媒体・アカウントごとの最終取得結果)を読む。
// シート上で日時が Date に変換されていても文字列でも扱えるよう、ISO文字列に揃えて返す
// (Dateオブジェクトは google.script.run で null になるため)。
// whitekeyに入れられていない予約(パーティーが無い等)。whitekey自動入力(scripts/whitekey-sync.mjs)が
// WhitekeyPending シートに書く。
// ダミー判定(lib/whitekeyRules.mjs の isDummyName と同じ規則。変える時は両方そろえること)。
const DUMMY_NAME_PATTERN_ = /ウィル|ウイル|うぃる|ういる|ホワイトキー|ほわいとき|ﾎﾜｲﾄｷｰ|whitekey|wonder|ワンダー/i;
const SYMBOL_ONLY_PATTERN_ = /^[\d\s\-_.・★☆※]+$/;
function isDummyName_(name) {
  const text = String(name || "").normalize("NFKC").trim();
  if (!text) return false;
  return DUMMY_NAME_PATTERN_.test(text) || SYMBOL_ONLY_PATTERN_.test(text);
}

// 金額の文字列("3,000円"等)を数にする。空・不明は null。
function parseAmount_(value) {
  const text = String(value === undefined || value === null ? "" : value).replace(/[^\d]/g, "");
  return text ? Number(text) : null;
}

// 性別の判断(lib/whitekeyPlan.mjs の judgeGender と同じ考え方)。媒体の性別欄・チケット名から。
// 戻り値: "女性" / "男性" / ""(判断できない=自動入力では男性として入力される)
function judgeGender_(row) {
  const text = `${row.genderHint || ""} ${row.ticketName || ""}`;
  if (/女/.test(text) && !/男/.test(text)) return "女性";
  if (/男/.test(text) && !/女/.test(text)) return "男性";
  return "";
}

function readWhitekeyPending_(ss) {
  const sheet = ss.getSheetByName("WhitekeyPending");
  if (!sheet) return [];
  return readObjects_(sheet).map((r) => ({
    eventDate: String(r.eventDate || ""),
    venue: String(r.venue || ""),
    time: String(r.time || ""),
    platform: String(r.platform || ""),
    name: String(r.name || ""),
    reason: String(r.reason || "")
  }));
}

function readSourceStatus_(ss) {
  const sheet = ss.getSheetByName(SOURCE_STATUS_SHEET);
  if (!sheet) return [];
  const iso = (v) => {
    if (!v) return "";
    if (Object.prototype.toString.call(v) === "[object Date]") return v.toISOString();
    return String(v);
  };
  return readObjects_(sheet).map((r) => ({
    platform: String(r.platform || ""),
    account: String(r.account || ""),
    status: String(r.status || ""),
    lastAttemptAt: iso(r.lastAttemptAt),
    lastSuccessAt: iso(r.lastSuccessAt),
    rowCount: Number(r.rowCount) || 0,
    message: String(r.message || ""),
    runner: String(r.runner || "")
  }));
}

// 「未紐づけ」画面から、媒体のイベントを公式イベントに紐づけて確定する。
// 媒体のイベントID(Peatix/こくちーず)があればPlatformEventMapに、無い媒体
// (Googleフォーム等)は生イベント名をキーにEventMasterに記録する。
// どちらも次回のスクレイピング以降はタイトルが変わっても外れず、
// 読み取り時にも対応表を引き直すためダッシュボードには即座に反映される。
// 人が確定した行(source=manual)は、自動処理では上書きされない。
function linkEvent(platform, account, platformEventId, rawEventName, officialEventId) {
  if (!isAuthorized_()) throw new Error("アクセス権がありません");
  const ss = SpreadsheetApp.openById(getSheetId_());
  let official;
  if (officialEventId === IGNORE_EVENT_ID_) {
    // 「対象外にする」: 別企画のイベントや去年の回答など、集計に含めない確定。
    // 元に戻すときは、PlatformEventMap/EventMasterのこの行を削除する。
    official = { canonicalEventId: IGNORE_EVENT_ID_, canonicalEventName: "対象外" };
  } else {
    const officialSheet = ss.getSheetByName(OFFICIAL_EVENTS_SHEET);
    official = (officialSheet ? readObjects_(officialSheet) : []).find(
      (o) => String(o.canonicalEventId || "").trim() === String(officialEventId || "").trim()
    );
    if (!official) throw new Error("紐づけ先の公式イベントが見つかりません: " + officialEventId);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const nowIso = new Date().toISOString();
    if (platformEventId) {
      const sheet = getOrCreateSheet_(ss, PLATFORM_EVENT_MAP_SHEET, PLATFORM_EVENT_MAP_HEADERS);
      const values = sheet.getDataRange().getValues();
      const headers = values[0];
      const col = (name) => headers.indexOf(name);
      const rowValues = {
        platform,
        platformEventId,
        officialEventId: String(official.canonicalEventId),
        officialEventName: String(official.canonicalEventName),
        title: rawEventName,
        source: "manual",
        updatedAt: nowIso
      };
      const out = headers.map((h) => (rowValues[h] !== undefined ? rowValues[h] : ""));
      let rowIndex = -1;
      for (let i = 1; i < values.length; i += 1) {
        if (String(values[i][col("platform")]) === platform && String(values[i][col("platformEventId")]) === platformEventId) {
          rowIndex = i + 1;
          break;
        }
      }
      if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([out]);
      else sheet.appendRow(out);
    } else {
      const sheet = getOrCreateSheet_(ss, EVENT_MASTER_SHEET, EVENT_MASTER_HEADERS);
      const values = sheet.getDataRange().getValues();
      const headers = values[0];
      const col = (name) => headers.indexOf(name);
      const rowValues = {
        canonicalEventId: String(official.canonicalEventId),
        canonicalEventName: String(official.canonicalEventName),
        platform,
        account,
        rawEventName
      };
      const out = headers.map((h) => (rowValues[h] !== undefined ? rowValues[h] : ""));
      let rowIndex = -1;
      for (let i = 1; i < values.length; i += 1) {
        if (
          String(values[i][col("platform")]) === platform &&
          String(values[i][col("account")]) === account &&
          String(values[i][col("rawEventName")]).trim() === String(rawEventName).trim()
        ) {
          rowIndex = i + 1;
          break;
        }
      }
      if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([out]);
      else sheet.appendRow(out);
    }
  } finally {
    lock.releaseLock();
  }
  clearDashboardCache_(); // 紐づけを変えたら、キャッシュした画面データを捨てて、すぐ反映する
  return { ok: true, officialEventName: String(official.canonicalEventName) };
}

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

// 会場名の表記ゆれ(日本語/英語/隣接エリア)を同一会場として扱うための表。
// wonder-plus-reservation-scraper側のlib/venues.mjsと同じ内容。
const VENUE_ALIASES_ = [
  ["北九州", "小倉", "kitakyushu", "kitakyusyu", "kokura"],
  ["福岡", "博多", "fukuoka", "hakata"],
  ["熊本", "kumamoto"],
  ["銀座", "ginza", "有楽町", "yurakucho"],
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
  ["大宮", "omiya"],
  ["オンライン", "online"]
];

// 「対象外にする」で確定した予約の印(scraper側のIGNORE_EVENT_IDと同じ値)。
const IGNORE_EVENT_ID_ = "__ignore__";

// scraper側lib/officialEventMatcher.mjsのisOldYearByWeekdayと同じ判定。
// 「10月16日（木）」のように曜日つきで、その曜日が今年の暦と合わず去年の暦なら
// 合う場合は、去年の開催回(フォームに残っている去年の選択肢)とみなす。
function isOldYearByWeekday_(text) {
  const match = String(text || "").match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*[（(]([日月火水木金土])[）)]/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const weekday = "日月火水木金土".indexOf(match[3]);
  const now = new Date();
  const year = now.getFullYear();
  if (new Date(year, month - 1, day).getDay() === weekday) return false;
  const lastYear = new Date(year - 1, month - 1, day);
  if (lastYear.getDay() !== weekday) return false;
  return now - lastYear > 60 * 24 * 60 * 60 * 1000;
}

function detectVenueKey_(text) {
  const normalized = String(text || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const hits = VENUE_ALIASES_.filter((aliases) =>
    aliases.some((alias) => normalized.indexOf(alias.normalize("NFKC").toLowerCase()) !== -1)
  ).map((aliases) => aliases[0]);
  if (hits.indexOf("高崎") !== -1) return "高崎";
  if (hits.indexOf("前橋") !== -1) return "前橋";
  return hits[0] || "";
}

// "6/24" "6月24日" のような表記から月日を取り出す
// (wonder-plus-reservation-scraper側のofficialEventMatcher.mjsと同じロジック)。
function extractMonthDayFromText_(text) {
  const match = String(text || "").match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

// "19:30" のような開始時刻を分単位に変換する(同日内の並び替え用)。
function extractStartMinutes_(text) {
  const match = String(text || "").match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 月日から実際の日付を推定する。年の記載が無い前提のため、今日から
// 極端に離れている(約10か月以上前/後)場合は年をまたいでいるとみなして
// 補正する(例: 12月に来年1月のイベントが「過去」に落ちてしまわないように)。
function resolveEventDate_(month, day) {
  if (!month || !day) return null;
  const now = new Date();
  const year = now.getFullYear();
  let candidate = new Date(year, month - 1, day);
  const diffDays = (candidate - now) / 86400000;
  if (diffDays < -300) candidate = new Date(year + 1, month - 1, day);
  else if (diffDays > 300) candidate = new Date(year - 1, month - 1, day);
  candidate.setHours(0, 0, 0, 0);
  return candidate;
}

// 媒体ごとにバラバラな生イベント名を、表示用に
// 「M/D 会場 イベント名 時刻」の形に近づけて整える。
// canonicalEventId/canonicalEventName自体は変更しないので、
// 予約の突き合わせ・集計には一切影響しない(見た目の整形のみ)。
function formatEventTitle_(rawName, month, day) {
  let text = String(rawName || "").trim();
  // 先頭の日付(+曜日があれば曜日も)("6/24（水）"や"10月30日（木）"、
  // 曜日無しの"9/29 "単体も)を取り除く。曜日部分を必須にしてしまうと、
  // 曜日の無い公式イベント名("9/29 北九州 ...")で日付が残ったままになり、
  // 後段でmonth/dayを付け直した際に日付が二重表示されてしまう。
  text = text.replace(/^\d{1,2}\s*[\/月]\s*\d{1,2}\s*日?\s*(?:（[月火水木金土日]）)?\s*/, "");
  // 残った曜日だけの括弧表記はまとめて除去
  text = text.replace(/（[月火水木金土日]）/g, "");
  // 「新宿会場」のような鉤括弧+「会場」表記を会場名だけに整える
  text = text.replace(/「([^」]*?)会場」/g, "$1 ");
  // 価格・キャンペーン表記("￥"以降)をまとめて除去
  text = text.replace(/￥[\s\S]*$/, "");
  // 会場名とタイトルの区切りの"/"を読みやすいスペースに変換(先頭1箇所のみ)
  text = text.replace(/\//, " ");
  // "会Wonder+" のように直前の語とくっついている場合にスペースを補う
  text = text.replace(/([^\s])Wonder\+/g, "$1 Wonder+");
  // 時刻の波ダッシュ表記("〜","～","–","—")を統一
  text = text.replace(/(\d{1,2}[:：]\d{2})\s*[~～〜–—]\s*(\d{1,2}[:：]\d{2})/, "$1-$2");
  text = text.replace(/\s+/g, " ").trim();
  return month && day ? `${month}/${day} ${text}`.trim() : text;
}

// UpdateControlシート: スマホ等からの「今すぐ更新」ボタンと、専用PC上で
// 常駐するポーリングスクリプト(wonder-plus-reservation-scraper側の
// peatix-update-watcher.mjs)が、同じスプレッドシートの1行を介して
// やり取りするための簡易な指示・状態欄。
// status: idle → requested(ボタン押下) → running(PC側が検知して処理中。
// ログイン待ちの間もmessageで状況を更新) → done/error。
function getUpdateControlSheet_(ss) {
  let sheet = ss.getSheetByName(UPDATE_CONTROL_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(UPDATE_CONTROL_SHEET);
    sheet.getRange(1, 1, 1, UPDATE_CONTROL_HEADERS.length).setValues([UPDATE_CONTROL_HEADERS]);
    sheet.getRange(2, 1, 1, UPDATE_CONTROL_HEADERS.length).setValues([["idle", "", "", ""]]);
  }
  return sheet;
}

function readUpdateControl_() {
  const ss = SpreadsheetApp.openById(getSheetId_());
  const sheet = getUpdateControlSheet_(ss);
  const values = sheet.getRange(2, 1, 1, UPDATE_CONTROL_HEADERS.length).getValues()[0];
  return { status: values[0] || "idle", message: values[1] || "", requestedAt: values[2] || "", updatedAt: values[3] || "" };
}

// このダッシュボードのボタンから呼ばれる想定。PC側のポーリングが
// status="requested" を検知して処理するので、ここでは指示を書き込むだけで
// 即座に返る(実際の取得完了は fetchUpdateStatus のポーリングで確認する)。
function requestPeatixUpdate() {
  if (!isAuthorized_()) throw new Error("アクセス権がありません");
  const current = readUpdateControl_();
  if (current.status === "requested" || current.status === "running") {
    return current; // 既に処理中なら二重リクエストしない
  }
  const ss = SpreadsheetApp.openById(getSheetId_());
  const sheet = getUpdateControlSheet_(ss);
  const now = new Date().toISOString();
  sheet.getRange(2, 1, 1, UPDATE_CONTROL_HEADERS.length).setValues([["requested", "更新をリクエストしました", now, now]]);
  return readUpdateControl_();
}

function fetchUpdateStatus() {
  if (!isAuthorized_()) throw new Error("アクセス権がありません");
  return readUpdateControl_();
}

// ?tab=unlinked のようにURLで開くタブを指定できる(未紐づけ画面のブックマーク用)。
// データはクライアントがfetchDashboardDataで取得するので、ここでは組み立てない
// (以前は使われないdataJsonのために毎回二重に組み立てており、初回表示が遅かった)。
function doGet(e) {
  // 公開ページ(GitHub Pages)からの取得用。?api=関数名&args=JSON配列&key=共有キー
  if (e && e.parameter && e.parameter.api) return apiResponse_(e.parameter.api, e.parameter.args, e.parameter.key);
  // 旧画面(鍵なしで誰でも開けた画面)は止めた。氏名を含むデータを鍵なしで見られないようにし、
  // 画面は新しい共有URL(鍵つき・GitHub Pages)に一本化している。
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>Wonder+ 集客状況ダッシュボード</title></head>" +
      '<body style="font-family:sans-serif;padding:24px;line-height:1.7">' +
      "<h1 style=\"font-size:18px\">この画面は新しいURLに移りました</h1>" +
      "<p>共有された<strong>鍵つきのURL</strong>(末尾が <code>#k=…</code>)から開いてください。</p>" +
      '<p><a href="https://wonderplus100-stack.github.io/reservation-scraper/" target="_top">新しいダッシュボードを開く</a></p>' +
      "<p style=\"color:#667085;font-size:13px\">鍵つきURLが分からない場合は、管理者にお問い合わせください。</p>" +
      "</body></html>"
  ).setTitle("Wonder+ 集客状況ダッシュボード");
}

// ---- 公開ページ(静的ページ)向けのJSON API ----
// script.google.com 上のページは、複数のGoogleアカウントでログイン中のブラウザだと
// 「ファイルを開くことができません」になることがあるため、画面は静的なページ(GitHub Pages)で
// 配信し、データだけをここから取得する。氏名を含むので、スプレッドシートの「Config」シートの
// dashboardKey(B列)と一致する共有キーが無い要求は拒否する(キーは共有URLの #k= に入れる)。
const API_FUNCTIONS_ = {
  fetchDashboardData: fetchDashboardData,
  fetchUpdateStatus: fetchUpdateStatus,
  requestPeatixUpdate: requestPeatixUpdate,
  linkEvent: linkEvent
};

function readDashboardKey_() {
  const sheet = SpreadsheetApp.openById(getSheetId_()).getSheetByName("Config");
  if (!sheet) return "";
  const rows = sheet.getDataRange().getValues();
  const row = rows.find((r) => String(r[0]).trim() === "dashboardKey");
  return row ? String(row[1] || "").trim() : "";
}

function apiResponse_(fnName, argsJson, key) {
  let body;
  try {
    const expected = readDashboardKey_();
    if (!expected || String(key || "") !== expected) throw new Error("共有URL(鍵つき)から開いてください");
    const fn = API_FUNCTIONS_[fnName];
    if (!fn) throw new Error("未対応の操作です: " + fnName);
    const args = argsJson ? JSON.parse(argsJson) : [];
    body = { ok: true, result: fn.apply(null, args) };
  } catch (err) {
    body = { error: true, message: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

// 書き込み系(紐づけの保存・更新リクエスト)は本文(JSON)で受ける。
function doPost(e) {
  let payload = {};
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    payload = {};
  }
  return apiResponse_(payload.fn, JSON.stringify(payload.args || []), payload.key);
}

// 画面データの組み立て(約8秒)の結果を、5分間キャッシュする。ページは5分おきに自動更新するため、
// 誰かが開いていれば、2回目以降はすぐ表示される。キャッシュは大きいので、小さく分割して保存する。
const DASH_CACHE_PREFIX_ = "dashboard_v4"; // 画面データの形を変えたら数字を上げる(古いキャッシュを使わないため)
const DASH_CACHE_SECONDS_ = 300;
const DASH_CACHE_CHUNK_ = 30000; // 文字数。1キー100KB上限に、日本語(最大3バイト/文字)でも収まる大きさ

function getDashboardDataCached_() {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(DASH_CACHE_PREFIX_ + "_n") || 0);
  if (count > 0) {
    const keys = [];
    for (let i = 0; i < count; i += 1) keys.push(DASH_CACHE_PREFIX_ + "_" + i);
    const parts = cache.getAll(keys);
    if (keys.every((k) => parts[k] !== undefined)) {
      try {
        return JSON.parse(keys.map((k) => parts[k]).join(""));
      } catch (err) {
        // 壊れたキャッシュは使わず、作り直す
      }
    }
  }
  const data = buildDashboardData_();
  try {
    const json = JSON.stringify(data);
    const values = {};
    let n = 0;
    for (let i = 0; i < json.length; i += DASH_CACHE_CHUNK_) values[DASH_CACHE_PREFIX_ + "_" + n++] = json.slice(i, i + DASH_CACHE_CHUNK_);
    values[DASH_CACHE_PREFIX_ + "_n"] = String(n);
    cache.putAll(values, DASH_CACHE_SECONDS_);
  } catch (err) {
    // キャッシュに保存できなくても、表示は続ける
  }
  return data;
}

function clearDashboardCache_() {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(DASH_CACHE_PREFIX_ + "_n") || 0);
  const keys = [DASH_CACHE_PREFIX_ + "_n"];
  for (let i = 0; i < count; i += 1) keys.push(DASH_CACHE_PREFIX_ + "_" + i);
  cache.removeAll(keys);
}

// ダッシュボード側のJSからポーリングして最新化するためのAPI。
function fetchDashboardData() {
  if (!isAuthorized_()) throw new Error("アクセス権がありません");
  try {
    return getDashboardDataCached_();
  } catch (err) {
    // google.script.runはサーバー側の例外を必ずしもwithFailureHandlerに
    // 渡してくれるとは限らない(オブジェクトのシリアライズに失敗すると
    // 成功ハンドラにnullが渡ることがある)ため、原因調査用に一時的に
    // エラー内容をそのまま返す。
    return { error: true, message: String(err && err.message || err), stack: String(err && err.stack || "") };
  }
}

