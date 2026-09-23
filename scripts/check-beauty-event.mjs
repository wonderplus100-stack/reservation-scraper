import "dotenv/config";
import { RAW_DATA_SHEET, UNMAPPED_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";

const sheetId = process.env.SHEET_ID;
const raw = await readSheetAsObjects(sheetId, RAW_DATA_SHEET);
const unmapped = await readSheetAsObjects(sheetId, UNMAPPED_SHEET);

const rawHits = raw.filter((r) => r.canonicalEventId && r.canonicalEventId.includes("9-24-銀座"));
console.log("RawData (canonicalEventId contains 9-24-銀座):", rawHits.length);
for (const r of rawHits) console.log(JSON.stringify(r));

const unmappedHits = unmapped.filter((r) => (r.rawEventName || "").includes("Beauty") || (r.rawEventName || "").includes("ビューティ"));
console.log("\nUnmapped (Beauty含む):", unmappedHits.length);
for (const r of unmappedHits) console.log(JSON.stringify(r));

const formsHits = raw.filter((r) => r.platform === "googleForms" && (r.rawEventName || "").includes("美容"));
console.log("\nRawData googleForms (美容含む):", formsHits.length);
for (const r of formsHits.slice(0, 5)) console.log(JSON.stringify(r));
