import { fetchEventPrices } from "./eventPrices.mjs";
import { toWhitekeyName } from "./whitekeyName.mjs";
import { DUMMY_MIN_COUNT, INACTIVE_STATUS, findDummyNames, isDummyName, isExcludedPerson, isWhitekeyKokuchproAccount, mediaPrefix, peatixCategoryOf } from "./whitekeyRules.mjs";

// 予約データ(RawData)から、whitekey「パーティー受付登録」に入れる内容(1予約=1件)を組み立てる。
// scripts/whitekey-plan.mjs(確認用の一覧)と scripts/whitekey-sync.mjs(開始35分前の自動入力)が共有する。
//
// ルール(ユーザー指定):
//  - 電話番号は 00000000000 / 生年月日 2000/1/1・年齢25 / 予約状況は「完了」
//  - 氏名はひらがな。名前(下の名)が分からなければ苗字のみ+名欄に番号(1,2,…)。同行者は同伴者欄
//  - 性別は媒体の情報(性別欄・チケット名)から判断、分からなければ男性
//  - 料金は予約元の金額(無ければ公式イベントページの参加費)。きっかけは取得先の媒体で決める
export const KEIYU_BY_PLATFORM = {
  kokuchpro: { value: "102", label: "こくちーず" },
  wpBookings: { value: "109", label: "Wonder+公式サイト" },
  peatix: { value: "104", label: "Peatix" },
  tunagate: { value: "103", label: "つなげーと" }
};
export const KEIYU_OTHER = { value: "9", label: "その他" };
const COMPANION_SUFFIX = /\(同行(\d+)\)$/;

// 公式イベントは年を持たないため、「次にその月日が来る日」が今日から150日以内なら
// これから開催されるイベントとみなす(数日前に終わったイベントは約1年後になるので除外される)。
export function isUpcoming(event, today) {
  const month = Number(event.month);
  const day = Number(event.day);
  let next = new Date(today.getFullYear(), month - 1, day);
  if (next < today) next = new Date(today.getFullYear() + 1, month - 1, day);
  return (next - today) / 86400000 <= 150;
}

export function judgeGender({ genderHint, ticketName }) {
  const text = `${genderHint || ""} ${ticketName || ""}`;
  if (/女/.test(text) && !/男/.test(text)) return { sexkbn: "2", basis: "媒体の情報(女性)" };
  if (/男/.test(text) && !/女/.test(text)) return { sexkbn: "1", basis: "媒体の情報(男性)" };
  return { sexkbn: "1", basis: "判断できず男性" };
}

// raw: RawDataの行 / official: OfficialEventsの行 / ledger: 入力済みの台帳(bookingKeyをキーにしたオブジェクト)
// eventFilter(event): 対象にする公式イベントを絞る関数
export async function buildEntries({ raw, official, ledger, sources, eventFilter }) {
  const officialById = new Map(official.map((e) => [e.canonicalEventId, e]));
  const groups = new Map();
  const skipped = { cancelled: 0, noEvent: 0, outOfScope: 0, entered: 0, dummy: 0, category: 0 };
  // こくちーずのダミー予約(同じ名前の予約が多数ある)は、全データから数えて除外する。
  const dummyNames = findDummyNames(raw, DUMMY_MIN_COUNT);
  for (const row of raw) {
    if (!sources.includes(row.platform)) continue;
    if (INACTIVE_STATUS.test(row.bookingStatus || "")) {
      skipped.cancelled += 1;
      continue;
    }
    // 予約一覧から外す個人(ユーザー指定)は、媒体を問わず入力しない。
    if (isExcludedPerson(row.reservationName)) {
      skipped.dummy += 1;
      continue;
    }
    const event = officialById.get(row.canonicalEventId);
    if (!event) {
      skipped.noEvent += 1;
      continue;
    }
    if (eventFilter && !eventFilter(event)) {
      skipped.outOfScope += 1;
      continue;
    }
    // こくちーずは、Whitekeyのアカウントの予約だけを入力する。
    if (row.platform === "kokuchpro" && !isWhitekeyKokuchproAccount(row.account)) {
      skipped.outOfScope += 1;
      continue;
    }
    if (row.platform === "kokuchpro" && (isDummyName(row.reservationName) || dummyNames.has(String(row.normalizedName || row.reservationName || "").trim()))) {
      skipped.dummy += 1;
      continue;
    }
    // Peatixは、カフェ会系・朝活異業種交流会・レギュラー異業種交流会のイベントだけ入力する。
    if (row.platform === "peatix" && !peatixCategoryOf(event)) {
      skipped.category += 1;
      continue;
    }
    const companion = String(row.reservationName).match(COMPANION_SUFFIX);
    const baseName = String(row.reservationName).replace(COMPANION_SUFFIX, "");
    const key = `${row.platform}|${row.canonicalEventId}|${baseName}`;
    if (!groups.has(key)) groups.set(key, { row: null, event, baseName, companions: 0, key });
    const group = groups.get(key);
    if (companion) group.companions += 1;
    else {
      group.row = row;
      // こくちーずの「枚数」(1申込で複数枚=複数人)も同行者として数える。
      group.quantity = Math.max(Number(row.quantity) || 1, 1);
    }
  }

  // 苗字ごとの通し番号(別人が同じ「姓+名の番号」にならないように、台帳の最大値から続ける)
  const seiCounter = new Map();
  for (const entry of Object.values(ledger)) {
    const n = Number(entry.meiNumber);
    if (entry.sei && n) seiCounter.set(entry.sei, Math.max(seiCounter.get(entry.sei) || 0, n));
  }
  const numberedMei = (sei) => {
    const next = (seiCounter.get(sei) || 0) + 1;
    seiCounter.set(sei, next);
    return { mei: String(next), meiNumber: next };
  };

  // 媒体に金額が無い予約(公式サイト等)は、公式イベントページの「男性/女性」の参加費を使う。
  const needPrice = [...groups.values()]
    .filter((g) => g.row && !ledger[g.row.bookingKey || g.key] && !String(g.row.amount || "").trim())
    .map((g) => g.event.canonicalEventId);
  const eventPrices = needPrice.length > 0 ? await fetchEventPrices(new Set(needPrice)) : new Map();

  const entries = [];
  for (const group of groups.values()) {
    if (!group.row) continue; // 代表者の行が無い(同行者だけ)ことは通常ない
    const bookingKey = group.row.bookingKey || group.key;
    if (ledger[bookingKey]) {
      skipped.entered += 1;
      continue;
    }
    const name = await toWhitekeyName(group.baseName, group.row.readingKatakana);
    const reasons = [];
    if (!name.sei) reasons.push("氏名を変換できない");
    if (name.splitGuessed) reasons.push("姓名の区切りを辞書で推定");
    const gender = judgeGender(group.row);
    if (gender.basis === "判断できず男性") reasons.push("性別を判断できず男性");
    let amount = String(group.row.amount || "").trim();
    let feeBasis = amount ? "媒体の金額" : "";
    if (!amount) {
      const price = eventPrices.get(group.event.canonicalEventId);
      if (price) {
        amount = String(gender.sexkbn === "2" ? price.female : price.male);
        feeBasis = "公式イベントページの参加費";
      } else {
        reasons.push("金額が不明(0円で入力)");
      }
    }
    // 姓の前に、媒体の頭文字を付ける(Peatix=P 等。付けない媒体もある)。
    const sei = mediaPrefix(group.row.platform, group.row.account) + name.sei;
    const people = [];
    const rep = name.hasGivenName ? { mei: name.mei, meiNumber: 0 } : numberedMei(sei);
    people.push({ sei, ...rep });
    const companionCount = Math.max(group.companions, (group.quantity || 1) - 1);
    for (let i = 0; i < companionCount; i += 1) people.push({ sei, ...numberedMei(sei) });

    entries.push({
      bookingKey,
      platform: group.row.platform,
      account: group.row.account,
      canonicalEventId: group.event.canonicalEventId,
      eventName: group.event.canonicalEventName,
      month: group.event.month,
      day: group.event.day,
      venue: group.event.venue,
      time: group.event.time,
      originalName: group.baseName,
      people,
      sexkbn: gender.sexkbn,
      genderBasis: gender.basis,
      fee: amount ? Number(amount) : 0,
      feeBasis,
      keiyu: KEIYU_BY_PLATFORM[group.row.platform] || KEIYU_OTHER,
      tel: "00000000000",
      birth: { year: "2000", month: "1", day: "1", age: "25" },
      status: "完了",
      reasons
    });
  }
  entries.sort((a, b) => Number(a.month) - Number(b.month) || Number(a.day) - Number(b.day) || a.time.localeCompare(b.time));
  return { entries, skipped };
}
