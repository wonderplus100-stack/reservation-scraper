import "dotenv/config";
import { fullSheetRange, readSheetValues } from "../lib/sheetsClient.mjs";

// 各Googleフォームの回答シートの列見出しを一覧表示する。
// 「担当者/紹介者」に相当する列が実在するか、実際の文言は何かを
// 確認するための一回限りの診断スクリプト。

async function main() {
  for (const index of [1, 2]) {
    const spreadsheetId = process.env[`FORM_${index}_SPREADSHEET_ID`];
    if (!spreadsheetId) {
      console.log(`FORM_${index}: 未設定`);
      continue;
    }
    const sheetName = process.env[`FORM_${index}_SHEET_NAME`] || "フォームの回答 1";
    const values = await readSheetValues(spreadsheetId, fullSheetRange(sheetName));
    const headerRow = values[0] || [];
    console.log(`\n--- FORM_${index} (${sheetName}) 列見出し ---`);
    headerRow.forEach((h, i) => console.log(`[${i}] ${h}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
