import { matchOfficialEventByStart } from "./officialEventMatcher.mjs";
import { platformEventKey } from "./sheetsClient.mjs";

// 自動投稿ツールがPostedEventsに記録した媒体イベント(IDつき)を、開始日時+
// 会場で公式イベントに特定し、PlatformEventMapに追加すべき行を返す。
//
// - 既に人が確定した行(source=manual)は上書きしない。
// - 既に同じ公式イベントに紐づいている行は何もしない。
// - 自動推測(source=auto)だけが入っていて公式イベントが違う場合は、
//   投稿時の記録の方が確かなので、posting-toolとして追記して上書きする
//   (PlatformEventMapは後の行が優先される)。
// 特定できない行(会場が曖昧など)は推測せず、そのまま残す
// (ダッシュボードの「未紐づけ」画面で人が確定する)。
export function resolvePostedEvents({ postedRows, officialEvents, mapByKey, nowIso }) {
  const added = [];
  for (const posted of postedRows) {
    const platform = String(posted.platform || "").trim();
    const platformEventId = String(posted.platformEventId || "").trim();
    if (!platform || !platformEventId) continue;

    const key = platformEventKey(platform, platformEventId);
    const current = mapByKey.get(key);
    if (current && current.source === "manual") continue;

    const start = String(posted.startAt || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!start) continue;
    const official = matchOfficialEventByStart(
      { month: Number(start[2]), day: Number(start[3]), time: `${start[4]}:${start[5]}`, title: posted.title },
      officialEvents
    );
    if (!official) continue;
    if (current && current.officialEventId === official.canonicalEventId) continue;

    const entry = {
      platform,
      platformEventId,
      officialEventId: official.canonicalEventId,
      officialEventName: official.canonicalEventName,
      title: posted.title,
      source: "posting-tool",
      updatedAt: nowIso
    };
    mapByKey.set(key, entry);
    added.push(entry);
  }
  return added;
}
