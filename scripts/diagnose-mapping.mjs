import "dotenv/config";
import { normalizeEventName } from "../lib/normalizeName.mjs";
import { UNMAPPED_SHEET, readEventMaster, readSheetAsObjects } from "../lib/sheetsClient.mjs";

// resolveCanonicalEventId が Unmapped の行を EventMaster と正しく
// 突き合わせられていない(resolved: 0 が続いている)原因を切り分けるため、
// 実際のフィールド値をそのまま比較表示する診断スクリプト。

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

  const [eventMaster, unmapped] = await Promise.all([
    readEventMaster(sheetId),
    readSheetAsObjects(sheetId, UNMAPPED_SHEET)
  ]);

  console.log(`EventMaster行数: ${eventMaster.length}`);
  console.log(`Unmapped行数: ${unmapped.length}`);

  console.log("\n--- EventMaster 先頭5件(生値) ---");
  for (const row of eventMaster.slice(0, 5)) {
    console.log(JSON.stringify({
      canonicalEventId: row.canonicalEventId,
      platform: row.platform,
      account: row.account,
      rawEventName: row.rawEventName,
      normalized: normalizeEventName(row.rawEventName)
    }));
  }

  console.log("\n--- Unmapped 先頭5件(生値) ---");
  for (const row of unmapped.slice(0, 5)) {
    console.log(JSON.stringify({
      platform: row.platform,
      account: row.account,
      rawEventName: row.rawEventName,
      normalized: normalizeEventName(row.rawEventName)
    }));
  }

  // Unmapped側の最初の1件について、EventMaster側で platform/account/normalized(rawEventName)
  // それぞれの一致条件を個別に確認する。
  if (unmapped.length > 0) {
    const target = unmapped[0];
    console.log("\n--- 突き合わせ診断(Unmapped[0]を基準) ---");
    console.log(`対象: platform=${JSON.stringify(target.platform)} account=${JSON.stringify(target.account)} rawEventName=${JSON.stringify(target.rawEventName)}`);

    const platformMatches = eventMaster.filter((r) => r.platform === target.platform);
    console.log(`platform一致件数: ${platformMatches.length}`);

    const accountMatches = platformMatches.filter((r) => r.account === target.account);
    console.log(`さらにaccount一致件数: ${accountMatches.length}`);
    if (platformMatches.length > 0 && accountMatches.length === 0) {
      const sampleAccounts = [...new Set(platformMatches.map((r) => r.account))].slice(0, 5);
      console.log(`EventMaster側の実際のaccount値サンプル: ${JSON.stringify(sampleAccounts)}`);
    }

    const nameMatches = accountMatches.filter(
      (r) => normalizeEventName(r.rawEventName) === normalizeEventName(target.rawEventName)
    );
    console.log(`さらにrawEventName正規化一致件数: ${nameMatches.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
