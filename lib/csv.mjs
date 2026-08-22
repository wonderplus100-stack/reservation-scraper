export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        i += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);
  return rows.filter((cells) => cells.some((cell) => String(cell || "").trim()));
}

export function tableFromCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const headers = rows.shift() || [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] || ""])));
}

// こくちーずPROの参加者名簿CSVはShift JISで出力される。
export function decodeShiftJis(buffer) {
  return new TextDecoder("shift_jis").decode(buffer);
}

// ヘッダーの候補文字列(部分一致)から実際の列名を探す。
export function findColumn(headers, candidates) {
  return headers.find((header) => candidates.some((candidate) => header.includes(candidate)));
}
