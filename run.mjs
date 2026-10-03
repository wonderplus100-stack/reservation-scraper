import "dotenv/config";
import { normalizeEventName, normalizeName } from "./lib/normalizeName.mjs";
import { matchOfficialEvent } from "./lib/officialEventMatcher.mjs";
import {
  RAW_DATA_SHEET,
  UNMAPPED_SHEET,
  appendEventMasterRows,
  appendPlatformEventMapRows,
  platformEventKey,
  readEventMaster,
  readOfficialEvents,
  readPlatformEventMap,
  readPostedEvents,
  readSheetAsObjects,
  replaceRawRows,
  replaceUnmappedRows,
  resolveCanonicalEventId,
  writeSummary
} from "./lib/sheetsClient.mjs";
import { resolvePostedEvents } from "./lib/postedEvents.mjs";
import * as evemado from "./scrapers/evemado.mjs";
import * as googleForms from "./scrapers/googleForms.mjs";
import * as jimoty from "./scrapers/jimoty.mjs";
import * as kokuchpro from "./scrapers/kokuchpro.mjs";
import * as peatix from "./scrapers/peatix.mjs";
import * as tunagate from "./scrapers/tunagate.mjs";

const SCRAPERS = { evemado, googleForms, jimoty, kokuchpro, peatix, tunagate };

// 1媒体あたりの上限時間。こくちーずPRO等がCI環境でハングし、
// GitHub Actionsのジョブ上限を使い切って強制キャンセルされる事故が
// 繰り返し発生したため、1媒体が固まっても他の媒体・シート更新へ確実に
// 進めるように上限を設ける。こくちーずPROは実データで40イベント×複数開催回を
// 1件ずつCSVダウンロードするため他の媒体より本質的に時間がかかる
// (実測で40イベントに約5分)ことが確認できたため、個別に長めの上限を設ける。
const SCRAPER_TIMEOUT_MS = 3 * 60 * 1000;
const SCRAPER_TIMEOUT_OVERRIDES_MS = {
  // 「申込ありのイベント」に絞り込んでもなお83件あり(実測で10分でも
  // 完走しない)、イベントごとの開催回数(セッション数)にもばらつきが
  // 大きいため、余裕を持って15分の上限にする。
  kokuchpro: 15 * 60 * 1000,
  // Peatixは「終了」タブだけで1,000件超のイベント履歴があり、申込み数>0の
  // イベントだけに絞ってもなお実測で数百件規模になる(1アカウントあたり)。
  // 1件ずつ参加者一覧ページへ遷移してCSVをダウンロードする都合上、
  // 相応に時間がかかるため大きめの上限を設ける。
  peatix: 60 * 60 * 1000,
  // 問い合わせのある投稿ごとに「スレッド一覧ページ」+「記事ページ」の
  // 2回遷移が必要(実測82投稿)なため、既定の3分では完走しない。
  jimoty: 20 * 60 * 1000
};

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
      const timeoutMs = SCRAPER_TIMEOUT_OVERRIDES_MS[name] || SCRAPER_TIMEOUT_MS;
      const collected = await withTimeout(scraper.collect(), timeoutMs, name);
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
  const officialEvents = await readOfficialEvents(sheetId);
  const platformEventMap = await readPlatformEventMap(sheetId);
  const eventMasterById = new Map(eventMaster.map((row) => [row.canonicalEventId, row]));
  const officialById = new Map(officialEvents.map((event) => [event.canonicalEventId, event]));
  const mapByKey = new Map(platformEventMap.map((row) => [platformEventKey(row.platform, row.platformEventId), row]));

  // 解決の優先順位:
  //  1) 媒体側のイベントID(PlatformEventMap)  ← タイトルが編集されても外れない
  //  2) 旧来のEventMaster(生イベント名の一致)
  //  3) 公式スケジュール(OfficialEvents)との日付+会場+シリーズ名による自動推測
  // 2)・3)で解決できたものは、イベントIDがあればPlatformEventMapに
  // (source=auto)として固定しておき、次回以降はタイトルに依存しない。
  // IDを持たない媒体(Googleフォーム・ジモティ等)の3)はEventMasterへ追記する。
  const coveredKeys = new Set(
    eventMaster.map((row) => `${row.platform}|||${row.account}|||${normalizeEventName(row.rawEventName)}`)
  );
  const newEventMasterRows = [];
  const newMapRows = [];
  const nowIso = new Date().toISOString();

  // 自動投稿ツールが投稿時に記録した媒体イベントID(PostedEvents)を、行の解決より
  // 前に取り込む。推測ではなく「このIDのイベントを、この日時に投稿した」という
  // 確かな記録なので、auto(自動推測)より優先して公式イベントに紐づける。
  const postedAdded = resolvePostedEvents({
    postedRows: await readPostedEvents(sheetId),
    officialEvents,
    mapByKey,
    nowIso
  });
  newMapRows.push(...postedAdded);
  if (postedAdded.length > 0) {
    console.log(`自動投稿ツールの投稿記録から${postedAdded.length}件を公式イベントに紐づけました。`);
  }

  function pinToPlatformEventMap(row, canonicalEventId, canonicalEventName) {
    if (!row.platformEventId) return;
    const key = platformEventKey(row.platform, row.platformEventId);
    if (mapByKey.has(key)) return;
    const entry = {
      platform: row.platform,
      platformEventId: row.platformEventId,
      officialEventId: canonicalEventId,
      officialEventName: canonicalEventName,
      title: row.rawEventName,
      source: "auto",
      updatedAt: nowIso
    };
    mapByKey.set(key, entry);
    newMapRows.push(entry);
  }

  const resolved = [];
  const unmapped = [];
  const unresolvedRaw = []; // 紐づけ未確定でもダッシュボードの「未紐づけ」画面で扱えるよう、RawDataにも残す

  for (const row of rawRows) {
    let canonicalEventId = null;
    let canonicalEventName = null;

    if (row.platformEventId) {
      const mapped = mapByKey.get(platformEventKey(row.platform, row.platformEventId));
      const official = mapped ? officialById.get(mapped.officialEventId) : null;
      if (official) {
        canonicalEventId = official.canonicalEventId;
        canonicalEventName = official.canonicalEventName;
      }
    }

    if (!canonicalEventId) {
      canonicalEventId = resolveCanonicalEventId(eventMaster, row.platform, row.account, row.rawEventName);
      canonicalEventName = canonicalEventId ? eventMasterById.get(canonicalEventId)?.canonicalEventName : null;
      if (canonicalEventId && officialById.has(canonicalEventId)) {
        pinToPlatformEventMap(row, canonicalEventId, canonicalEventName);
      }
    }

    if (!canonicalEventId) {
      const officialMatch = matchOfficialEvent(row.rawEventName, officialEvents);
      if (officialMatch) {
        canonicalEventId = officialMatch.canonicalEventId;
        canonicalEventName = officialMatch.canonicalEventName;
        if (row.platformEventId) {
          pinToPlatformEventMap(row, canonicalEventId, canonicalEventName);
        } else {
          const key = `${row.platform}|||${row.account}|||${normalizeEventName(row.rawEventName)}`;
          if (!coveredKeys.has(key)) {
            coveredKeys.add(key);
            newEventMasterRows.push({
              canonicalEventId,
              canonicalEventName,
              platform: row.platform,
              account: row.account,
              rawEventName: row.rawEventName
            });
          }
        }
      }
    }

    if (!canonicalEventId) {
      unmapped.push(row);
      unresolvedRaw.push({ ...row, canonicalEventId: "", normalizedName: normalizeName(row.reservationName) });
      continue;
    }
    resolved.push({
      ...row,
      canonicalEventId,
      canonicalEventName: canonicalEventName || row.rawEventName,
      normalizedName: normalizeName(row.reservationName)
    });
  }

  if (newEventMasterRows.length > 0) {
    await appendEventMasterRows(sheetId, newEventMasterRows);
    console.log(`公式スケジュールとの突き合わせでEventMasterに${newEventMasterRows.length}件追加しました。`);
  }
  if (newMapRows.length > 0) {
    await appendPlatformEventMapRows(sheetId, newMapRows);
    console.log(`媒体のイベントIDによる紐づけ(PlatformEventMap)に${newMapRows.length}件追加しました。`);
  }

  console.log(`resolved: ${resolved.length}, unmapped(要イベントマスタ登録): ${unmapped.length}`);

  // RawData/Unmapped は「今回の実行時点でのスナップショット」として書き直す
  // (appendすると実行のたびに重複が積み上がるため)。ただし --only で一部の
  // 媒体だけを実行した場合、対象外の媒体の直近データを消してしまわないよう、
  // 既存シートから対象外媒体の行だけ残して合成する。
  //
  // 重要: 対象媒体であっても、(セッション切れ等で)今回1件も取得できな
  // かった「media+account」の組み合わせは、「今回のスナップショットで
  // 置き換える」対象から除外し、既存の行をそのまま残す。
  // 媒体単位(platformのみ)で判定すると、例えばPeatixのWonder Plusだけ
  // ログイン失敗してJua Partyは成功した場合に、「peatixは今回データが
  // あった」と判定されてWonder Plus側の既存データだけが失われてしまう
  // (媒体単位の判定だけでは防げなかった実際の事故)。platform+account の
  // 組み合わせ単位で判定することで、これを防ぐ。
  const [existingRaw, existingUnmapped] = await Promise.all([
    readSheetAsObjects(sheetId, RAW_DATA_SHEET),
    readSheetAsObjects(sheetId, UNMAPPED_SHEET)
  ]);
  const targetSet = new Set(targets);
  const accountKey = (row) => `${row.platform}|||${row.account}`;
  const accountsWithFreshData = new Set(rawRows.map(accountKey));
  const shouldReplace = (row) => targetSet.has(row.platform) && accountsWithFreshData.has(accountKey(row));

  const existingAccountKeys = new Set([...existingRaw, ...existingUnmapped].map(accountKey));
  const skippedAccounts = [...existingAccountKeys].filter(
    (key) => targetSet.has(key.split("|||")[0]) && !accountsWithFreshData.has(key)
  );
  if (skippedAccounts.length > 0) {
    console.warn(
      `今回0件だったため既存データを維持したアカウント: ${skippedAccounts.map((k) => k.replace("|||", "/")).join(", ")}(取得失敗の可能性があります)`
    );
  }
  const keptRaw = existingRaw.filter((row) => !shouldReplace(row));
  const keptUnmapped = existingUnmapped.filter((row) => !shouldReplace(row));

  const finalRaw = [...keptRaw, ...resolved, ...unresolvedRaw];
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
