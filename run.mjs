import "dotenv/config";
import { normalizeName } from "./lib/normalizeName.mjs";
import {
  RAW_DATA_SHEET,
  UNMAPPED_SHEET,
  readEventMaster,
  readSheetAsObjects,
  replaceRawRows,
  replaceUnmappedRows,
  resolveCanonicalEventId,
  writeSummary
} from "./lib/sheetsClient.mjs";
import * as googleForms from "./scrapers/googleForms.mjs";
import * as kokuchpro from "./scrapers/kokuchpro.mjs";
import * as peatix from "./scrapers/peatix.mjs";
import * as tunagate from "./scrapers/tunagate.mjs";

const SCRAPERS = { googleForms, kokuchpro, peatix, tunagate };

// 1媒体あたりの上限時間。こくちーずPRO等がCI環境でハングし、
// GitHub Actionsのジョブ上限(15分)を使い切って強制キャンセルされる事故が
// 繰り返し発生したため、1媒体が固まっても他の媒体・シート更新へ確実に
// 進めるように上限を設ける。
const SCRAPER_TIMEOUT_MS = 3 * 60 * 1000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: ${ms / 1000}秒でタイムアウトしました`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseOnlyArg() {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return Object.keys(SCRAPERS);
  return arg.replace("--only=", "").split(",").map((s) => s.trim());
}

async function collectAll(targets) {
  const rows = [];
  for (const name of targets) {
    const scraper = SCRAPERS[name];
    if (!scraper) {
      console.warn(`未知のスクレイパー指定です: ${name}`);
      continue;
    }
    console.log(`--- collecting: ${name} ---`);
    try {
      const collected = await withTimeout(scraper.collect(), SCRAPER_TIMEOUT_MS, name);
      console.log(`${name}: ${collected.length}件`);
      rows.push(...collected);
    } catch (err) {
      console.error(`${name} の取得に失敗しました:`, err);
    }
  }
  return rows;
}

function buildSummary(resolvedRows) {
  // canonicalEventId + platform_account ごとに、正規化した氏名でユニーク集計する。
  const groups = new Map();
  for (const row of resolvedRows) {
    const key = `${row.canonicalEventId}${row.platform}/${row.account}`;
    if (!groups.has(key)) {
      groups.set(key, {
        canonicalEventId: row.canonicalEventId,
        canonicalEventName: row.canonicalEventName,
        platform_account: `${row.platform}/${row.account}`,
        names: new Set()
      });
    }
    groups.get(key).names.add(row.normalizedName);
  }
  const updatedAt = new Date().toISOString();
  return Array.from(groups.values()).map((group) => ({
    canonicalEventId: group.canonicalEventId,
    canonicalEventName: group.canonicalEventName,
    platform_account: group.platform_account,
    uniqueReservationCount: group.names.size,
    updatedAt
  }));
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

  const targets = parseOnlyArg();
  const rawRows = await collectAll(targets);

  const eventMaster = await readEventMaster(sheetId);
  const eventMasterById = new Map(eventMaster.map((row) => [row.canonicalEventId, row]));

  const resolved = [];
  const unmapped = [];

  for (const row of rawRows) {
    const canonicalEventId = resolveCanonicalEventId(eventMaster, row.platform, row.account, row.rawEventName);
    if (!canonicalEventId) {
      unmapped.push(row);
      continue;
    }
    resolved.push({
      ...row,
      canonicalEventId,
      canonicalEventName: eventMasterById.get(canonicalEventId)?.canonicalEventName || row.rawEventName,
      normalizedName: normalizeName(row.reservationName)
    });
  }

  console.log(`resolved: ${resolved.length}, unmapped(要イベントマスタ登録): ${unmapped.length}`);

  // RawData/Unmapped は「今回の実行時点でのスナップショット」として書き直す
  // (appendすると実行のたびに重複が積み上がるため)。ただし --only で一部の
  // 媒体だけを実行した場合、対象外の媒体の直近データを消してしまわないよう、
  // 既存シートから対象外媒体の行だけ残して合成する。
  const [existingRaw, existingUnmapped] = await Promise.all([
    readSheetAsObjects(sheetId, RAW_DATA_SHEET),
    readSheetAsObjects(sheetId, UNMAPPED_SHEET)
  ]);
  const targetSet = new Set(targets);
  const keptRaw = existingRaw.filter((row) => !targetSet.has(row.platform));
  const keptUnmapped = existingUnmapped.filter((row) => !targetSet.has(row.platform));

  const finalRaw = [...keptRaw, ...resolved];
  const finalUnmapped = [...keptUnmapped, ...unmapped];

  await replaceRawRows(sheetId, finalRaw);
  await replaceUnmappedRows(sheetId, finalUnmapped);

  // Summaryはfinalの全件から再集計する(EventMasterの名称変更にも追従させる)。
  const summarySource = finalRaw
    .filter((row) => row.canonicalEventId)
    .map((row) => ({
      ...row,
      canonicalEventName: eventMasterById.get(row.canonicalEventId)?.canonicalEventName || row.rawEventName,
      normalizedName: row.normalizedName || normalizeName(row.reservationName)
    }));
  const summary = buildSummary(summarySource);
  await writeSummary(sheetId, summary);

  console.log(`Summary更新: ${summary.length}行`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // タイムアウトで見捨てたスクレイパーのブラウザが残っている場合、
    // そのハンドルがイベントループを掴んだままプロセスが終了しない
    // ことがあるため、明示的に終了させる。
    process.exit(process.exitCode ?? 0);
  });
