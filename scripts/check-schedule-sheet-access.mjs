import "dotenv/config";
import { fullSheetRange, readSheetValues } from "../lib/sheetsClient.mjs";

// wonder-plus-portal が読んでいる「公式スケジュール」スプレッドシートに、
// 既存のサービスアカウントでアクセスできるかを確認する一回限りの診断。
const SCHEDULE_SPREADSHEET_ID = "1SRb3_nwgPWEj2Kb44SDD38SI0HmkllE4G_P7DPYKGKk";
const SCHEDULE_SHEET = "整形済み";

async function main() {
  try {
    const values = await readSheetValues(SCHEDULE_SPREADSHEET_ID, fullSheetRange(SCHEDULE_SHEET));
    console.log(`アクセス成功。行数: ${values.length}`);
    console.log("先頭3行:", JSON.stringify(values.slice(0, 3)));
  } catch (err) {
    console.log(`アクセス失敗: ${err.message}`);
  }
}

main();
