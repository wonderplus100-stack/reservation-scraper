import "dotenv/config";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, appendWhitekeyCancelled, readSheetAsObjects, readWhitekeyCancelled, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { executeCancels, findCancelCandidates } from "../lib/whitekeyCancelSync.mjs";
import { openPartyList, openWhitekey } from "../lib/whitekeyClient.mjs";

// 予約側でキャンセルになった予約を、whitekeyでも「キャンセル」にする(自動入力した予約だけ)。条件は lib/whitekeyCancelSync.mjs を参照。
// 実行は --commit を付けた時だけ(付けなければ、対象を表示するだけ)。
// 使い方: node scripts/whitekey-cancel-sync.mjs [--commit] [--limit=15] [--days=5] [--only=氏名の一部]
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split("=")[1];
const commit = process.argv.includes("--commit");
const limit = Number(arg("limit", 15));
const daysBack = Number(arg("days", 5));
const sheetId = process.env.SHEET_ID;

const [raw, ledger, cancelled] = await Promise.all([readSheetAsObjects(sheetId, RAW_DATA_SHEET), readWhitekeyLedger(sheetId), readWhitekeyCancelled(sheetId)]);
const only = arg("only", "");
const found = findCancelCandidates({ raw, ledger, cancelledSet: new Set(Object.keys(cancelled)), daysBack });
const skipped = found.skipped;
const candidates = only ? found.candidates.filter((c) => String(c.ledger.name).includes(only)) : found.candidates;
console.log(`キャンセルの候補: ${candidates.length}件(うち手作業 ${candidates.filter((c) => c.manual).length}件)/ 申し直しがあるため除外 ${skipped.rebooked}件`);
if (candidates.length === 0) process.exit(0);
const wk = await openWhitekey();
let results = [];
try {
  await openPartyList(wk.page);
  results = await executeCancels(wk.page, candidates, { commit, limit });
} finally {
  await wk.close();
}
if (commit) {
  const rows = results.filter((r) => ["キャンセル", "既にキャンセル済み"].includes(r.result)).map((r) => ({ bookingKey: r.ledger.bookingKey, partycode: r.ledger.partycode, eventDate: r.ledger.eventDate, name: r.ledger.name, result: r.result, cancelledAt: new Date().toISOString() }));
  await appendWhitekeyCancelled(sheetId, rows);
}
const count = {};
results.forEach((r) => (count[r.result.split(":")[0]] = (count[r.result.split(":")[0]] || 0) + 1));
console.log("結果:", JSON.stringify(count));
