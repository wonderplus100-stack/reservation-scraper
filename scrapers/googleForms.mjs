import { reportSource } from "../lib/sourceStatus.mjs";
import { hiraganaToKatakana } from "../lib/normalizeName.mjs";
import { fullSheetRange, readSheetValues } from "../lib/sheetsClient.mjs";

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
  // FORM_1〜6 のうち、スプレッドシートIDが設定されているものを対象にする。
  for (const index of [1, 2, 3, 4, 5, 6]) {
    const spreadsheetId = process.env[`FORM_${index}_SPREADSHEET_ID`];
    if (!spreadsheetId) continue;
    accounts.push({
      label: process.env[`FORM_${index}_ACCOUNT_LABEL`] || `Googleフォーム${index}`,
      spreadsheetId,
      sheetName: process.env[`FORM_${index}_SHEET_NAME`] || "フォームの回答 1",
      namePattern: process.env[`FORM_${index}_NAME_COLUMN_PATTERN`] || "お名前",
      eventPattern: process.env[`FORM_${index}_EVENT_COLUMN_PATTERN`] || "参加希望日",
      // 「開催日,イベント名,開催時間」のように複数の列見出しをカンマ区切りで指定すると、
      // それらの値を連結した文字列を1件のイベント名として扱う(LP予約一覧のように
      // イベントが日付・名称・時間の別列に分かれているシート用)。未設定なら従来どおり。
      eventComposeColumns: (process.env[`FORM_${index}_EVENT_COMPOSE_COLUMNS`] || "")
        .split(",").map((s) => s.trim()).filter(Boolean),
      // 担当者/紹介者列は、フォームによって列見出しの文言も有無も異なるため
      // アカウントごとに環境変数で指定できるようにする(未設定なら集計しない)。
      referrerPattern: process.env[`FORM_${index}_REFERRER_COLUMN_PATTERN`] || ""
    });
  }
  return accounts;
}

// 日付("2026/09/23" や "7/27")は "M/D" に揃える。イベント名の先頭に既に同じ日付が
// 入っている古い行("7/27 前橋 Wonder+ ...")では、日付を二重にしない。
function composeEventName([date, title, time]) {
  const md = String(date || "").match(/(?:\d{4}[\/-])?(\d{1,2})[\/-](\d{1,2})/);
  const dateText = md ? `${Number(md[1])}/${Number(md[2])}` : String(date || "");
  const parts = [];
  if (!title || !title.startsWith(dateText)) parts.push(dateText);
  if (title) parts.push(title);
  if (time && !(title || "").includes(time)) parts.push(time);
  return parts.filter(Boolean).join(" ").trim();
}

function extractReservations(values, { namePattern, eventPattern, referrerPattern, eventComposeColumns = [] }) {
  const [headerRow, ...dataRows] = values;
  if (!headerRow) return [];

  // 「お名前」は「お名前(フリガナ)」のようなふりがな列も部分一致してしまうため、
  // フリガナ/カナを示す見出しは除外する(実データで確認して発覚した問題)。
  // ただしふりがな列自体はカタカナ書き出し用に別途値を取得しておく。
  const FURIGANA_MARKERS = ["フリガナ", "ふりがな", "カナ", "ｶﾅ"];
  const nameColumnIndexes = headerRow
    .map((header, index) => ({ header: String(header || ""), index }))
    .filter(({ header }) => header.includes(namePattern) && !FURIGANA_MARKERS.some((marker) => header.includes(marker)))
    .map(({ index }) => index);
  const readingColumnIndexes = headerRow
    .map((header, index) => ({ header: String(header || ""), index }))
    .filter(({ header }) => header.includes(namePattern) && FURIGANA_MARKERS.some((marker) => header.includes(marker)))
    .map(({ index }) => index);
  const referrerColumnIndexes = referrerPattern
    ? headerRow
        .map((header, index) => ({ header: String(header || ""), index }))
        .filter(({ header }) => header.includes(referrerPattern))
        .map(({ index }) => index)
    : [];
  const eventColumns = headerRow
    .map((header, index) => ({ header: String(header || "").trim(), index }))
    .filter(({ header }) => header.includes(eventPattern));

  const composeIndexes = eventComposeColumns.map((name) =>
    headerRow.findIndex((header) => String(header || "").trim() === name)
  );
  if (composeIndexes.some((i) => i < 0)) {
    throw new Error(`イベント名を組み立てる列が見つかりません: ${eventComposeColumns.join(",")}`);
  }

  const results = [];
  for (const row of dataRows) {
    const reservationName = nameColumnIndexes
      .map((i) => String(row[i] || "").trim())
      .find(Boolean);
    if (!reservationName) continue;

    const readingKana = readingColumnIndexes
      .map((i) => String(row[i] || "").trim())
      .find(Boolean) || "";
    const referrerName = referrerColumnIndexes
      .map((i) => String(row[i] || "").trim())
      .find(Boolean) || "";

    if (composeIndexes.length > 0) {
      const rawEventName = composeEventName(composeIndexes.map((i) => String(row[i] || "").trim()));
      if (rawEventName) {
        results.push({ reservationName, rawEventName, readingKatakana: hiraganaToKatakana(readingKana), referrerName });
      }
      continue;
    }

    for (const { header, index } of eventColumns) {
      const value = String(row[index] || "").trim();
      if (!value) continue;
      // 列見出し(地域名を含む)と回答値を組み合わせて、地域ごとに別イベントとして扱う。
      results.push({
        reservationName,
        rawEventName: `${header}：${value}`,
        readingKatakana: hiraganaToKatakana(readingKana),
        referrerName
      });
    }
  }
  return results;
}

export async function collect() {
  const accounts = accountsFromEnv();
  const rows = [];
  const obtainedAt = new Date().toISOString();

  for (const account of accounts) {
    // 1つのフォームの失敗(シート名変更など)で、もう一方のフォームまで取得できなく
    // ならないよう、アカウントごとに分けて失敗を報告する。
    let reservations;
    try {
      const values = await readSheetValues(account.spreadsheetId, fullSheetRange(account.sheetName));
      reservations = extractReservations(values, account);
      reportSource("googleForms", account.label, { ok: true });
    } catch (err) {
      console.error(`googleForms(${account.label}) の取得に失敗しました:`, err.message);
      reportSource("googleForms", account.label, { ok: false, message: err.message });
      continue;
    }
    for (const reservation of reservations) {
      rows.push({
        platform: "googleForms",
        account: account.label,
        rawEventName: reservation.rawEventName,
        reservationName: reservation.reservationName,
        readingKatakana: reservation.readingKatakana,
        referrerName: reservation.referrerName,
        obtainedAt
      });
    }
  }
  return rows;
}
