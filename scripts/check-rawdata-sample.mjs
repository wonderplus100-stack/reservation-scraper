import "dotenv/config";
import { RAW_DATA_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";

// readingKatakana/referrerName が実際にRawDataへ反映されているかを
// 確認するための一回限りの診断スクリプト。referrerNameが入っている行と
// 入っていない行の両方をサンプル表示する。

async function main() {
  const sheetId = process.env.SHEET_ID;
  const rows = await readSheetAsObjects(sheetId, RAW_DATA_SHEET);
  const withReferrer = rows.filter((r) => r.platform === "googleForms" && String(r.referrerName || "").trim());
  const withoutReferrer = rows.filter((r) => r.platform === "googleForms" && !String(r.referrerName || "").trim());

  console.log(`googleForms行数: ${rows.filter((r) => r.platform === "googleForms").length}`);
  console.log(`referrerNameあり: ${withReferrer.length}件`);
  console.log(`referrerNameなし: ${withoutReferrer.length}件`);

  console.log("\n--- referrerNameありサンプル3件 ---");
  for (const r of withReferrer.slice(0, 3)) {
    console.log(JSON.stringify({
      account: r.account,
      reservationName: r.reservationName,
      readingKatakana: r.readingKatakana,
      referrerName: r.referrerName
    }));
  }

  console.log("\n--- referrerNameなしサンプル3件(readingKatakanaのみ確認) ---");
  for (const r of withoutReferrer.slice(0, 3)) {
    console.log(JSON.stringify({
      account: r.account,
      reservationName: r.reservationName,
      readingKatakana: r.readingKatakana
    }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
