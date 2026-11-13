import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { buildEntries, isUpcoming } from "../lib/whitekeyPlan.mjs";

// whitekeyに入れる内容を、予約データ(RawData)から組み立てて確認用の一覧にする。
// このスクリプトは一覧を作るだけで、whitekeyには一切アクセスしない(登録しない)。
// 組み立てのルールは lib/whitekeyPlan.mjs。
//
// 使い方: node scripts/whitekey-plan.mjs [--sources=kokuchpro,wpBookings] [--all-dates]
//   既定は「これから150日以内の開催」だけを対象にする。--all-dates で過去分も含める。
const DATA_DIR = path.resolve("data");

function argValue(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function main() {
  const sheetId = process.env.SHEET_ID;
  const sources = argValue("sources", "kokuchpro,wpBookings").split(",").map((s) => s.trim());
  const allDates = process.argv.includes("--all-dates");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [raw, official, ledger] = await Promise.all([
    readSheetAsObjects(sheetId, RAW_DATA_SHEET),
    readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET),
    readWhitekeyLedger(sheetId)
  ]);
  const { entries, skipped } = await buildEntries({
    raw, official, ledger, sources,
    eventFilter: allDates ? null : (event) => isUpcoming(event, today)
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "whitekey-plan.json"), JSON.stringify(entries, null, 2));
  const header = ["日付", "会場", "開始", "取得先", "きっかけ", "元の氏名", "入力する姓", "入力する名", "同行者", "性別", "性別の根拠", "料金", "料金の根拠", "要確認"];
  const lines = entries.map((e) =>
    [
      `${e.month}/${e.day}`, e.venue, e.time, e.platform, e.keiyu.label, e.originalName,
      e.people[0].sei, e.people[0].mei, e.people.length - 1,
      e.sexkbn === "2" ? "女" : "男", e.genderBasis, e.fee, e.feeBasis, e.reasons.join(" / ")
    ].map(csvCell).join(",")
  );
  fs.writeFileSync(path.join(DATA_DIR, "whitekey-plan.csv"), "﻿" + [header.join(","), ...lines].join("\r\n"));

  const bySource = {};
  entries.forEach((e) => { bySource[e.platform] = (bySource[e.platform] || 0) + 1; });
  console.log(`入力予定: ${entries.length}件 ${JSON.stringify(bySource)} / 要確認あり: ${entries.filter((e) => e.reasons.length > 0).length}件`);
  console.log(`除外: キャンセル${skipped.cancelled} / 公式イベント未紐づけ${skipped.noEvent} / 対象外の開催${skipped.outOfScope} / 入力済み${skipped.entered}`);
  console.log("出力: data/whitekey-plan.csv, data/whitekey-plan.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
