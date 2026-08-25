import { google } from "googleapis";
import { normalizeEventName } from "./normalizeName.mjs";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export const RAW_DATA_SHEET = "RawData";
export const EVENT_MASTER_SHEET = "EventMaster";
export const SUMMARY_SHEET = "Summary";
export const UNMAPPED_SHEET = "Unmapped";

// RawData/Unmapped の列順。GASダッシュボード側もこの並びを前提にする。
export const RAW_DATA_HEADERS = [
  "platform",
  "account",
  "rawEventName",
  "canonicalEventId",
  "reservationName",
  "normalizedName",
  "obtainedAt"
];

let cachedAuth = null;

function getAuth() {
  if (cachedAuth) return cachedAuth;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("環境変数 GOOGLE_SERVICE_ACCOUNT_JSON が設定されていません(サービスアカウントのJSON鍵を1行のJSON文字列で設定してください)");
  }
  const credentials = JSON.parse(raw);
  cachedAuth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return cachedAuth;
}

async function getSheetsApi() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

// シート全体を読むためのA1記法range文字列を作る。スペースなどを含む
// シート名はシングルクォートが必要で、かつ引用符付きシート名を単独で
// (末尾に!A1形式のセル範囲を付けずに)渡すと Sheets API が
// "Unable to parse range" エラーを返すことを実データで確認したため、
// 常に "!A:ZZ" (全行・広めの列範囲)を付与した完全な形にする。
export function fullSheetRange(sheetName) {
  const quoted = `'${String(sheetName).replace(/'/g, "''")}'`;
  return `${quoted}!A:ZZ`;
}

// 汎用: 任意のスプレッドシート(Googleフォームの回答シートなど)を読む。
// サービスアカウントに閲覧権限を共有しておく必要がある。
export async function readSheetValues(spreadsheetId, range) {
  const sheets = await getSheetsApi();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

export async function readSheetAsObjects(spreadsheetId, sheetName) {
  const values = await readSheetValues(spreadsheetId, fullSheetRange(sheetName));
  if (values.length === 0) return [];
  const [headerRow, ...rows] = values;
  return rows.map((row) => Object.fromEntries(headerRow.map((header, i) => [header, row[i] ?? ""])));
}

// RawData/Unmapped は「今回の実行時点での全件スナップショット」を書き込む。
// 以前はappendしていたが、こくちーずPRO等はログインの都度対象イベントの
// 全参加者を取得し直す仕様のため、appendのままだと実行のたびに同じ
// データが積み重なり続けてしまう(実際に30分おきの自動実行で
// 912件→21,003件まで重複が積み上がる事故が発生した)。
// 毎回クリアしてから書き直すことで、シートは常に「最新の状態」を表す。
async function replaceSheet(sheetId, sheetName, headers, values) {
  const sheets = await getSheetsApi();
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: sheetName });
  if (values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] }
    });
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers, ...values] }
  });
}

export async function replaceRawRows(sheetId, rows) {
  const values = rows.map((row) => RAW_DATA_HEADERS.map((key) => row[key] ?? ""));
  await replaceSheet(sheetId, RAW_DATA_SHEET, RAW_DATA_HEADERS, values);
}

const UNMAPPED_HEADERS = ["platform", "account", "rawEventName", "obtainedAt"];

export async function replaceUnmappedRows(sheetId, rows) {
  const values = rows.map((row) => [row.platform, row.account, row.rawEventName, row.obtainedAt]);
  await replaceSheet(sheetId, UNMAPPED_SHEET, UNMAPPED_HEADERS, values);
}

// EventMaster: canonicalEventId, canonicalEventName, platform, account, rawEventName の5列を想定。
export async function readEventMaster(sheetId) {
  return readSheetAsObjects(sheetId, EVENT_MASTER_SHEET);
}

const EVENT_MASTER_HEADERS = ["canonicalEventId", "canonicalEventName", "platform", "account", "rawEventName"];

// EventMasterは手動で名前を編集している可能性があるため、RawData/Unmappedと
// 違って上書き(replace)はせず、末尾に追記(append)する。
export async function appendEventMasterRows(sheetId, rows) {
  if (rows.length === 0) return;
  const sheets = await getSheetsApi();
  const values = rows.map((row) => EVENT_MASTER_HEADERS.map((key) => row[key] ?? ""));
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: EVENT_MASTER_SHEET,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values }
  });
}

// 媒体・アカウント・生イベント名から canonicalEventId を解決する。
// 1) platform+account+rawEventName の完全一致(正規化後)を優先
// 2) 見つからなければ canonicalEventName との正規化一致にフォールバック
export function resolveCanonicalEventId(eventMaster, platform, account, rawEventName) {
  const normalizedRaw = normalizeEventName(rawEventName);
  const exact = eventMaster.find(
    (row) =>
      row.platform === platform &&
      row.account === account &&
      normalizeEventName(row.rawEventName) === normalizedRaw
  );
  if (exact) return exact.canonicalEventId;

  const byName = eventMaster.find((row) => normalizeEventName(row.canonicalEventName) === normalizedRaw);
  return byName ? byName.canonicalEventId : null;
}

// Summary シートを全消去して集計結果で書き直す。
export async function writeSummary(sheetId, summaryRows) {
  const sheets = await getSheetsApi();
  const headers = ["canonicalEventId", "canonicalEventName", "platform_account", "uniqueReservationCount", "updatedAt"];
  const values = [headers, ...summaryRows.map((row) => headers.map((key) => row[key] ?? ""))];
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: SUMMARY_SHEET });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SUMMARY_SHEET}!A1`,
    valueInputOption: "RAW",
    requestBody: { values }
  });
}
