import "dotenv/config";
import { getConfigValue, setConfigValue } from "../lib/sheetsClient.mjs";

// whitekeyへの本番登録(自動入力)の入り切りを、スプレッドシートの Config(whitekeyCommit)で切り替える。専用PCの .env を触らずに、どのPCからでも切り替えられる。
// 専用PCの5分おきのタスクは、実行のたびに Config を読み、true のとき登録する(それ以外は「入れる予定」を表示するだけ)。
// 使い方: node scripts/whitekey-switch.mjs on | off | status
const action = process.argv[2] || "status";
const sheetId = process.env.SHEET_ID;
const current = (await getConfigValue(sheetId, "whitekeyCommit")).toLowerCase() === "true";
if (action === "on" || action === "off") {
  await setConfigValue(sheetId, "whitekeyCommit", action === "on" ? "true" : "false");
  console.log(`whitekeyCommit を ${action === "on" ? "true(登録する)" : "false(登録しない)"} にしました。専用PCの次の5分おきの実行から反映されます。`);
} else {
  console.log(`whitekeyCommit(Config): ${current ? "true(登録する)" : "false/未設定(登録しない)"}`);
}
