import "dotenv/config";
import { RAW_DATA_SHEET, UNMAPPED_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";

const sheetId = process.env.SHEET_ID;
const raw = await readSheetAsObjects(sheetId, RAW_DATA_SHEET);
const byPlatform = {};
for (const r of raw) byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1;
console.log("RawData platform counts:", byPlatform);

const unmapped = await readSheetAsObjects(sheetId, UNMAPPED_SHEET);
const unmappedByPlatform = {};
for (const r of unmapped) unmappedByPlatform[r.platform] = (unmappedByPlatform[r.platform] || 0) + 1;
console.log("Unmapped platform counts:", unmappedByPlatform);

console.log("sample unmapped rows (peatix/kokuchpro):");
for (const r of unmapped) {
  if (r.platform === "peatix" || r.platform === "kokuchpro") {
    console.log(JSON.stringify(r));
  }
}
