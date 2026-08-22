import { quoteSheetName, readSheetValues } from "../lib/sheetsClient.mjs";

// Googleフォームはそれ自体にログインが不要 — フォームの回答が書き込まれる
// 連携スプレッドシートを、サービスアカウントに「閲覧者」共有した上で直接読む。
//
// 実データを確認したところ、フォームによって構造が大きく異なることが分かった:
// - FORM_2: シンプルに「お名前（フルネーム）」「参加希望日時」の単一列。
// - FORM_1: 関東/中部/関西/東北信越/中国四国/九州ごとに「ご参加希望日◯◯」という
//   列が分かれており(回答者は自分の地域の列だけに入力し、他は空欄)、かつ
//   「お名前（フルネーム）...」という列見出しが2回登場する(Googleフォームで
//   同じ質問文を複数セクションに配置すると、回答スプレッドシート上は同名の列が
//   複数できるため)。単純に列名を1つ指定するだけでは正しく拾えない。
//
// そのため「氏名列」「イベント列」は完全一致の1列ではなく、列見出しに含まれる
// 部分文字列(パターン)で指定する。氏名は該当する列のうち最初に値が入っている
// ものを採用し、イベント列は該当する列ごとに(値が入っていれば)1件ずつ
// 予約として扱う(1人が複数地域に回答することは通常ないが、technicalに複数
// 該当しても両方登録されるだけで安全側に倒れる)。
function accountsFromEnv() {
  const accounts = [];
  for (const index of [1, 2]) {
    const spreadsheetId = process.env[`FORM_${index}_SPREADSHEET_ID`];
    if (!spreadsheetId) continue;
    accounts.push({
      label: process.env[`FORM_${index}_ACCOUNT_LABEL`] || `Googleフォーム${index}`,
      spreadsheetId,
      sheetName: process.env[`FORM_${index}_SHEET_NAME`] || "フォームの回答 1",
      namePattern: process.env[`FORM_${index}_NAME_COLUMN_PATTERN`] || "お名前",
      eventPattern: process.env[`FORM_${index}_EVENT_COLUMN_PATTERN`] || "参加希望日"
    });
  }
  return accounts;
}

function extractReservations(values, { namePattern, eventPattern }) {
  const [headerRow, ...dataRows] = values;
  if (!headerRow) return [];

  // 「お名前」は「お名前(フリガナ)」のようなふりがな列も部分一致してしまうため、
  // フリガナ/カナを示す見出しは除外する(実データで確認して発覚した問題)。
  const FURIGANA_MARKERS = ["フリガナ", "ふりがな", "カナ", "ｶﾅ"];
  const nameColumnIndexes = headerRow
    .map((header, index) => ({ header: String(header || ""), index }))
    .filter(({ header }) => header.includes(namePattern) && !FURIGANA_MARKERS.some((marker) => header.includes(marker)))
    .map(({ index }) => index);
  const eventColumns = headerRow
    .map((header, index) => ({ header: String(header || "").trim(), index }))
    .filter(({ header }) => header.includes(eventPattern));

  const results = [];
  for (const row of dataRows) {
    const reservationName = nameColumnIndexes
      .map((i) => String(row[i] || "").trim())
      .find(Boolean);
    if (!reservationName) continue;

    for (const { header, index } of eventColumns) {
      const value = String(row[index] || "").trim();
      if (!value) continue;
      // 列見出し(地域名を含む)と回答値を組み合わせて、地域ごとに別イベントとして扱う。
      results.push({ reservationName, rawEventName: `${header}：${value}` });
    }
  }
  return results;
}

export async function collect() {
  const accounts = accountsFromEnv();
  const rows = [];
  const obtainedAt = new Date().toISOString();

  for (const account of accounts) {
    const values = await readSheetValues(account.spreadsheetId, quoteSheetName(account.sheetName));
    const reservations = extractReservations(values, account);
    for (const reservation of reservations) {
      rows.push({
        platform: "googleForms",
        account: account.label,
        rawEventName: reservation.rawEventName,
        reservationName: reservation.reservationName,
        obtainedAt
      });
    }
  }
  return rows;
}
