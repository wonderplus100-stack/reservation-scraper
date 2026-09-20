import "dotenv/config";
import { RAW_DATA_SHEET, UNMAPPED_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";

const sheetId = process.env.SHEET_ID;
const raw = await readSheetAsObjects(sheetId, RAW_DATA_SHEET);
const unmapped = await readSheetAsObjects(sheetId, UNMAPPED_SHEET);

function breakdown(rows) {
  const counts = {};
  for (const r of rows) {
    const key = `${r.platform}/${r.account}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

console.log("RawData:", JSON.stringify(breakdown(raw), null, 1));
console.log("Unmapped:", JSON.stringify(breakdown(unmapped), null, 1));

const wonderPlusRaw = raw.filter((r) => r.platform === "peatix" && r.account === "Wonder Plus");
console.log(`peatix/Wonder Plus 件数(RawData): ${wonderPlusRaw.length}`);
console.log("サンプル:", wonderPlusRaw.slice(0, 3).map((r) => ({ name: r.reservationName, canonicalEventId: r.canonicalEventId, obtainedAt: r.obtainedAt })));
