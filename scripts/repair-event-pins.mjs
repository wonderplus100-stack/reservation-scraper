import "dotenv/config";
import fs from "node:fs";
import { readOfficialEvents, readPlatformEventMap, removeAutoPlatformEventMapRows, repinAutoPlatformEventMapRows } from "../lib/sheetsClient.mjs";
import { isPlausibleMapping, matchOfficialEvent } from "../lib/officialEventMatcher.mjs";

// 媒体のイベント → 公式イベントの「自動の紐づけ(PlatformEventMap の source=auto)」のうち、あり得ない組み合わせのものを直す。
// (題名が恋愛・合コン系 / 題名の開始時刻が公式イベントと3時間を超えてずれる。manual と posting-tool の行には触れない)
//   ・いまの照合で正しい公式イベントが見つかれば、そちらに付け替える  ・見つからなければ、紐づけを外す(「未紐づけ」に戻る)
// 使い方: node scripts/repair-event-pins.mjs [--apply]   (--apply が無ければ、対象を表示するだけ。適用前の内容は data/pin-repair-backup.json に保存)
const apply = process.argv.includes("--apply");
const [official, pins] = await Promise.all([readOfficialEvents(process.env.SHEET_ID), readPlatformEventMap(process.env.SHEET_ID)]);
const byId = new Map(official.map((e) => [e.canonicalEventId, e]));
const fixes = [], removals = [];
for (const p of pins) {
  if (p.source !== "auto") continue;
  const e = byId.get(p.officialEventId);
  if (!e || isPlausibleMapping(p.title, e)) continue;
  const next = matchOfficialEvent(p.title, official);
  const label = `${p.platform}/${p.platformEventId} ${e.month}/${e.day} ${e.venue} ${e.time}`;
  if (next && next.canonicalEventId !== p.officialEventId) { fixes.push({ p, next }); console.log(`  付け替え: ${label} → ${next.month}/${next.day} ${next.venue} ${next.time} | ${String(p.title).slice(0, 40)}`); }
  else { removals.push(p); console.log(`  外す: ${label} | ${String(p.title).slice(0, 50)}`); }
}
console.log(`付け替え ${fixes.length}件 / 外す ${removals.length}件`);
if (apply && (fixes.length || removals.length)) {
  fs.writeFileSync("data/pin-repair-backup.json", JSON.stringify({ fixes: fixes.map((f) => f.p), removals }, null, 1));
  const n1 = await repinAutoPlatformEventMapRows(process.env.SHEET_ID, fixes.map(({ p, next }) => ({ platform: p.platform, platformEventId: p.platformEventId, officialEventId: next.canonicalEventId, officialEventName: next.canonicalEventName })));
  const removed = await removeAutoPlatformEventMapRows(process.env.SHEET_ID, removals.map((p) => ({ platform: p.platform, platformEventId: p.platformEventId })));
  console.log(`適用: 付け替え ${n1}件 / 外した行 ${removed.length}件`);
}
