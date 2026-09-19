import "dotenv/config";
import { RAW_DATA_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";

const sheetId = process.env.SHEET_ID;
const raw = await readSheetAsObjects(sheetId, RAW_DATA_SHEET);
const rows = raw.filter((r) => r.canonicalEventId === "official-9-17-銀座-20002200");
console.log(`該当行数: ${rows.length}`);
for (const r of rows) {
  console.log(JSON.stringify({ platform: r.platform, account: r.account, name: r.reservationName, katakana: r.readingKatakana, obtainedAt: r.obtainedAt }));
}
