import "dotenv/config";
import { google } from "googleapis";
import { EVENT_MASTER_SHEET } from "../lib/sheetsClient.mjs";

// EventMasterシートの1行目(ヘッダー)が、本来5列(canonicalEventId /
// canonicalEventName / platform / account / rawEventName)に分かれているべき
// ところ、1つのセルにまとめて入力されてしまっており、readSheetAsObjects()が
// 列名を正しく認識できず、resolveCanonicalEventIdが常に0件になっていた。
// データ本体(2行目以降)には触れず、ヘッダー行だけを正しい5列に上書きする。

const HEADERS = ["canonicalEventId", "canonicalEventName", "platform", "account", "rawEventName"];

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const sheets = google.sheets({ version: "v4", auth });

  const before = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${EVENT_MASTER_SHEET}'!A1:E1`
  });
  console.log("修正前のヘッダー行:", JSON.stringify(before.data.values));

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${EVENT_MASTER_SHEET}'!A1:E1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] }
  });

  const after = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${EVENT_MASTER_SHEET}'!A1:E1`
  });
  console.log("修正後のヘッダー行:", JSON.stringify(after.data.values));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
