import "dotenv/config";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { matchOfficialEventByStart } from "../lib/officialEventMatcher.mjs";
import {
  platformEventKey,
  readOfficialEvents,
  readPlatformEventMap,
  replacePlatformEventMapRows
} from "../lib/sheetsClient.mjs";

// 自動投稿ツール(Streamlit, ローカルPC)が投稿時に記録している
// 「Peatixイベント ↔ こくちーずの開催ページ」の対応を、PlatformEventMapに
// 取り込む。自動投稿ツール側のDBは読み取り専用で開き、一切書き換えない。
//
// 自動投稿ツールのcampaign_hub.sqlite3は、1つのイベントを
// event_key = "peatix-{PeatixのイベントID}" で管理し、media_snapshotsに
// 媒体ごとの公開URLを持つ。こくちーずのURLは /event/{ハッシュ}/{開催ID}/
// の形式で、スクレイパーが使う「ハッシュ/開催ID」キーと一致する。
// 公式イベントとの対応は、同じく記録されている開始日時+タイトルの会場から
// 厳密に決める(曖昧なものは推測せず、ダッシュボードの「未紐づけ」で確定する)。
//
// ローカルPC専用(DBがこのPCにしか無いため)。環境変数POSTING_TOOL_DIRで
// 自動投稿ツールのフォルダを指定できる。

const POSTING_TOOL_DIR =
  process.env.POSTING_TOOL_DIR || "C:/Users/owner/Downloads/Python peatix_auto/PeatixTool";

function parseKokuchproKey(url) {
  const match = String(url || "").match(/kokuchpro\.com\/event\/([0-9a-f]+)\/(\d+)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

  const db = new DatabaseSync(path.join(POSTING_TOOL_DIR, "campaign_hub.sqlite3"), { readOnly: true });
  const campaigns = db.prepare("SELECT event_key, title, start_at FROM campaign_events").all();
  const urlRows = db
    .prepare("SELECT event_key, medium, event_url FROM media_snapshots WHERE event_url != ''")
    .all();
  db.close();

  const urlsByEvent = new Map();
  for (const row of urlRows) {
    if (!urlsByEvent.has(row.event_key)) urlsByEvent.set(row.event_key, []);
    urlsByEvent.get(row.event_key).push(row);
  }

  const officialEvents = await readOfficialEvents(sheetId);
  const existing = await readPlatformEventMap(sheetId);
  const byKey = new Map(existing.map((row) => [platformEventKey(row.platform, row.platformEventId), row]));

  const nowIso = new Date().toISOString();
  let mappedEvents = 0;
  let addedRows = 0;
  let updatedRows = 0;
  const unmatched = [];

  for (const campaign of campaigns) {
    const peatixId = String(campaign.event_key).replace(/^peatix-/, "");
    const start = String(campaign.start_at || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!start) {
      unmatched.push({ title: campaign.title, startAt: campaign.start_at, reason: "開始日時が不正" });
      continue;
    }
    const official = matchOfficialEventByStart(
      { month: Number(start[2]), day: Number(start[3]), time: `${start[4]}:${start[5]}`, title: campaign.title },
      officialEvents
    );
    if (!official) {
      unmatched.push({ title: campaign.title, startAt: campaign.start_at, reason: "公式イベントを一意に特定できない" });
      continue;
    }
    mappedEvents += 1;

    const targets = [{ platform: "peatix", platformEventId: peatixId }];
    for (const urlRow of urlsByEvent.get(campaign.event_key) || []) {
      if (urlRow.medium !== "kokuchpro") continue;
      const key = parseKokuchproKey(urlRow.event_url);
      if (key) targets.push({ platform: "kokuchpro", platformEventId: key });
    }

    for (const target of targets) {
      const key = platformEventKey(target.platform, target.platformEventId);
      const current = byKey.get(key);
      // 人が確定したもの(manual)は、自動処理で上書きしない。
      if (current && current.source === "manual") continue;
      if (current && current.source === "posting-tool" && current.officialEventId === official.canonicalEventId) continue;
      const entry = {
        platform: target.platform,
        platformEventId: target.platformEventId,
        officialEventId: official.canonicalEventId,
        officialEventName: official.canonicalEventName,
        title: campaign.title,
        source: "posting-tool",
        updatedAt: nowIso
      };
      byKey.set(key, entry);
      if (current) updatedRows += 1;
      else addedRows += 1;
    }
  }

  if (addedRows + updatedRows > 0) {
    await replacePlatformEventMapRows(sheetId, [...byKey.values()]);
  }

  console.log(`自動投稿ツールのイベント: ${campaigns.length}件`);
  console.log(`  公式イベントに特定できた: ${mappedEvents}件`);
  console.log(`  PlatformEventMap 追加: ${addedRows}行 / 更新: ${updatedRows}行`);
  console.log(`  特定できず保留(ダッシュボードの「未紐づけ」で確定): ${unmatched.length}件`);
  for (const item of unmatched.slice(0, 15)) {
    console.log(`    - ${item.startAt} ${item.title} (${item.reason})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
