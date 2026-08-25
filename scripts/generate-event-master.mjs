import "dotenv/config";
import { normalizeEventName } from "../lib/normalizeName.mjs";
import {
  UNMAPPED_SHEET,
  appendEventMasterRows,
  readEventMaster,
  readSheetAsObjects
} from "../lib/sheetsClient.mjs";

// Unmapped(まだEventMasterに登録されていない生データ)から、ユニークな
// (platform, account, rawEventName)の組み合わせを取り出し、EventMasterの
// 下書き行を自動生成して追記する。
//
// 既存のEventMaster行は上書きしない(手動でcanonicalEventNameを直しても
// 消えない)。既に登録済みの組み合わせはスキップし、本当に新しい
// イベントだけを追加する。
//
// 使い方:
//   node scripts/generate-event-master.mjs          追加を実行する
//   node scripts/generate-event-master.mjs --dry-run 追加せず、何件追加されるか確認するだけ

const PLATFORM_PREFIX = { googleForms: "gform", kokuchpro: "kkp", peatix: "ptx", tunagate: "tng" };

function makeCanonicalName(rawEventName) {
  // 「ご参加希望日◯◯：」のような列見出しプレフィックスを除去して読みやすい名称にする。
  return rawEventName.replace(/^[^：]*：/, "").trim();
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");
  const dryRun = process.argv.includes("--dry-run");

  const [eventMaster, unmapped] = await Promise.all([
    readEventMaster(sheetId),
    readSheetAsObjects(sheetId, UNMAPPED_SHEET)
  ]);

  // 既に登録済みの組み合わせ(正規化後)を集める。
  const covered = new Set(
    eventMaster.map((row) => `${row.platform}|||${row.account}|||${normalizeEventName(row.rawEventName)}`)
  );

  // 既存IDの連番の続きから採番する(prefixごとの最大値+1)。
  const counters = {};
  for (const row of eventMaster) {
    const m = String(row.canonicalEventId || "").match(/^([a-z]+)-(\d+)$/);
    if (!m) continue;
    const [, prefix, num] = m;
    counters[prefix] = Math.max(counters[prefix] || 0, Number(num));
  }

  const seenThisRun = new Set();
  const newRows = [];
  for (const row of unmapped) {
    const platform = row.platform;
    const account = row.account;
    const rawEventName = row.rawEventName;
    if (!platform || !rawEventName) continue;

    const key = `${platform}|||${account}|||${normalizeEventName(rawEventName)}`;
    if (covered.has(key) || seenThisRun.has(key)) continue;
    seenThisRun.add(key);

    const prefix = PLATFORM_PREFIX[platform] || platform;
    counters[prefix] = (counters[prefix] || 0) + 1;
    const canonicalEventId = `${prefix}-${String(counters[prefix]).padStart(3, "0")}`;

    newRows.push({
      canonicalEventId,
      canonicalEventName: makeCanonicalName(rawEventName),
      platform,
      account,
      rawEventName
    });
  }

  console.log(`Unmapped総数: ${unmapped.length}件 / 新規追加対象: ${newRows.length}件`);
  if (newRows.length > 0) {
    console.log("先頭5件のプレビュー:");
    for (const row of newRows.slice(0, 5)) {
      console.log(`  ${row.canonicalEventId}\t${row.canonicalEventName}`);
    }
  }

  if (dryRun) {
    console.log("--dry-run のため書き込みは行いません。");
    return;
  }

  await appendEventMasterRows(sheetId, newRows);
  console.log(`EventMasterに${newRows.length}件追加しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
