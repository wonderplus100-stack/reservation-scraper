import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";
import { toWhitekeyName } from "../lib/whitekeyName.mjs";

// whitekey(会員・パーティー管理システム)の「パーティー受付登録」に入れる内容を、
// 予約データ(RawData)から組み立てて一覧にする。このスクリプトは確認用の一覧を
// 作るだけで、whitekeyには一切アクセスしない(登録しない)。
//
// 使い方: node scripts/whitekey-plan.mjs [--sources=kokuchpro,wpBookings] [--all-dates]
//   既定は「これから150日以内の開催」だけを対象にする。--all-dates で過去分も含める。
//
// ルール(ユーザー指定):
//  - 電話番号は 00000000000 / 生年月日 2000/1/1・年齢25 / 予約状況は「完了」
//  - 氏名はひらがな。名前(下の名)が分からなければ苗字のみ+名欄に番号(1,2,…)
//  - 性別は媒体の情報(性別欄・チケット名)から判断、分からなければ男性
//  - 料金は予約元の金額。「パーティーを知ったきっかけ」は取得先の媒体で決める
const KEIYU_BY_PLATFORM = {
  kokuchpro: { value: "102", label: "こくちーず" },
  wpBookings: { value: "109", label: "Wonder+公式サイト" },
  peatix: { value: "104", label: "Peatix" },
  tunagate: { value: "103", label: "つなげーと" }
};
const KEIYU_OTHER = { value: "9", label: "その他" };

const DATA_DIR = path.resolve("data");
const LEDGER_PATH = path.join(DATA_DIR, "whitekey-ledger.json");
const COMPANION_SUFFIX = /\(同行(\d+)\)$/;

function argValue(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

// 公式イベントは年を持たないため、「次にその月日が来る日」が今日から150日以内なら
// これから開催されるイベントとみなす(数日前に終わったイベントは約1年後になるので除外される)。
function isUpcoming(event, today) {
  const month = Number(event.month);
  const day = Number(event.day);
  let next = new Date(today.getFullYear(), month - 1, day);
  if (next < today) next = new Date(today.getFullYear() + 1, month - 1, day);
  return (next - today) / 86400000 <= 150;
}

function judgeGender({ genderHint, ticketName }) {
  const text = `${genderHint || ""} ${ticketName || ""}`;
  if (/女/.test(text) && !/男/.test(text)) return { sexkbn: "2", basis: "媒体の情報(女性)" };
  if (/男/.test(text) && !/女/.test(text)) return { sexkbn: "1", basis: "媒体の情報(男性)" };
  return { sexkbn: "1", basis: "判断できず男性" };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  const sources = argValue("sources", "kokuchpro,wpBookings").split(",").map((s) => s.trim());
  const allDates = process.argv.includes("--all-dates");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [raw, official] = await Promise.all([
    readSheetAsObjects(sheetId, RAW_DATA_SHEET),
    readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET)
  ]);
  const officialById = new Map(official.map((e) => [e.canonicalEventId, e]));
  const ledger = readLedger();

  // 予約(代表者)ごとに、同行者の行(氏名に「(同行N)」が付く)をまとめる。
  const groups = new Map();
  const skipped = { cancelled: 0, noEvent: 0, past: 0, entered: 0 };
  for (const row of raw) {
    if (!sources.includes(row.platform)) continue;
    if (/キャンセル/.test(row.bookingStatus || "")) {
      skipped.cancelled += 1;
      continue;
    }
    const event = officialById.get(row.canonicalEventId);
    if (!event) {
      skipped.noEvent += 1;
      continue;
    }
    if (!allDates && !isUpcoming(event, today)) {
      skipped.past += 1;
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

  const seiCounter = new Map(); // 苗字ごとの通し番号(別人が同じ「姓+名の番号」にならないように)
  for (const entry of Object.values(ledger)) {
    const n = Number(entry.meiNumber);
    if (entry.sei && n) seiCounter.set(entry.sei, Math.max(seiCounter.get(entry.sei) || 0, n));
  }
  function numberedMei(sei) {
    const next = (seiCounter.get(sei) || 0) + 1;
    seiCounter.set(sei, next);
    return { mei: String(next), meiNumber: next };
  }

  const entries = [];
  for (const group of groups.values()) {
    if (!group.row) continue; // 代表者の行が無い(同行者だけ)ことは通常ない
    const bookingKey = group.row.bookingKey || group.key;
    if (ledger[bookingKey]) {
      skipped.entered += 1;
      continue;
    }
    const name = await toWhitekeyName(group.baseName);
    const reasons = [];
    if (!name.sei) reasons.push("氏名を変換できない");
    const gender = judgeGender(group.row);
    if (gender.basis === "判断できず男性") reasons.push("性別を判断できず男性");
    const amount = String(group.row.amount || "").trim();
    if (!amount) reasons.push("金額が不明(0円で入力)");
    const keiyu = KEIYU_BY_PLATFORM[group.row.platform] || KEIYU_OTHER;

    const people = [];
    const rep = name.hasGivenName ? { mei: name.mei, meiNumber: 0 } : numberedMei(name.sei);
    people.push({ sei: name.sei, ...rep });
    const companionCount = Math.max(group.companions, (group.quantity || 1) - 1);
    for (let i = 0; i < companionCount; i += 1) people.push({ sei: name.sei, ...numberedMei(name.sei) });

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
      keiyu,
      tel: "00000000000",
      birth: { year: "2000", month: "1", day: "1", age: "25" },
      status: "完了",
      reasons
    });
  }

  entries.sort((a, b) => Number(a.month) - Number(b.month) || Number(a.day) - Number(b.day) || a.time.localeCompare(b.time));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "whitekey-plan.json"), JSON.stringify(entries, null, 2));
  const header = ["日付", "会場", "開始", "取得先", "きっかけ", "元の氏名", "入力する姓", "入力する名", "同行者", "性別", "性別の根拠", "料金", "要確認"];
  const lines = entries.map((e) =>
    [
      `${e.month}/${e.day}`, e.venue, e.time, e.platform, e.keiyu.label, e.originalName,
      e.people[0].sei, e.people[0].mei, e.people.length - 1,
      e.sexkbn === "2" ? "女" : "男", e.genderBasis, e.fee, e.reasons.join(" / ")
    ].map(csvCell).join(",")
  );
  fs.writeFileSync(path.join(DATA_DIR, "whitekey-plan.csv"), "﻿" + [header.join(","), ...lines].join("\r\n"));

  const bySource = {};
  entries.forEach((e) => { bySource[e.platform] = (bySource[e.platform] || 0) + 1; });
  const review = entries.filter((e) => e.reasons.length > 0).length;
  console.log(`入力予定: ${entries.length}件 ${JSON.stringify(bySource)} / 要確認あり: ${review}件`);
  console.log(`除外: キャンセル${skipped.cancelled} / 公式イベント未紐づけ${skipped.noEvent} / 過去開催${skipped.past} / 入力済み${skipped.entered}`);
  console.log("出力: data/whitekey-plan.csv, data/whitekey-plan.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
