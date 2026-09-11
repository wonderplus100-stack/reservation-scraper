import "dotenv/config";
import { getVenueKey } from "../lib/venues.mjs";
import { fullSheetRange, readSheetValues, replaceOfficialEvents } from "../lib/sheetsClient.mjs";

// Wonder+公式HPの裏側にある「公式スケジュール表」を取り込み、
// 予約データの有無によらない「本来あるべきイベント一覧」を
// OfficialEventsシートに書き出す。ダッシュボードのプルダウンは
// このシートを正として表示する。

function slugifyTime(time) {
  return String(time || "").replace(/[^\d]/g, "");
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");
  const scheduleSpreadsheetId = process.env.SCHEDULE_SPREADSHEET_ID;
  if (!scheduleSpreadsheetId) throw new Error("環境変数 SCHEDULE_SPREADSHEET_ID が設定されていません");
  const scheduleSheetName = process.env.SCHEDULE_SHEET_NAME || "整形済み";

  const values = await readSheetValues(scheduleSpreadsheetId, fullSheetRange(scheduleSheetName));
  const [headerRow, ...rows] = values;
  if (!headerRow) throw new Error("公式スケジュール表が空です");
  const objects = rows.map((row) => Object.fromEntries(headerRow.map((h, i) => [h, row[i] ?? ""])));

  const events = [];
  const seenIds = new Set();
  for (const row of objects) {
    const month = Number(row["月"]);
    const day = Number(row["日"]);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) continue;

    const venue = String(row["会場"] || "").trim();
    const eventName = String(row["イベント名"] || "").trim();
    const time = String(row["時間"] || "").trim();
    const capacity = String(row["人数"] || "").trim();
    if (!venue) continue;

    const venueKey = getVenueKey(venue) || venue;
    let canonicalEventId = `official-${month}-${day}-${venueKey}-${slugifyTime(time)}`;
    // 同一日・同一会場・同一時刻の重複行がまれにあるため、IDが衝突したら連番を振る。
    let suffix = 2;
    while (seenIds.has(canonicalEventId)) {
      canonicalEventId = `official-${month}-${day}-${venueKey}-${slugifyTime(time)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(canonicalEventId);

    const canonicalEventName = [`${month}/${day}`, venue, eventName, time].filter(Boolean).join(" ");

    events.push({ canonicalEventId, canonicalEventName, month, day, venue, venueKey, time, capacity });
  }

  await replaceOfficialEvents(sheetId, events);
  console.log(`OfficialEventsを${events.length}件で更新しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
