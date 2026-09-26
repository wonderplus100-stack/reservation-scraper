import "dotenv/config";
import { withBrowser } from "../lib/browser.mjs";

await withBrowser("peatix-Wonder Plus", async (page, { hasSavedState }) => {
  if (!hasSavedState) {
    console.log("保存済みセッションがありません");
    return;
  }
  await page.goto("https://peatix.com/user/27385050/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const endedTab = page.getByRole("link", { name: /^終了\s*\|/ });
  await endedTab.first().click().catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2000);

  let lastCount = -1;
  let stableStreak = 0;
  for (let i = 0; i < 400; i += 1) {
    const count = await page.evaluate(() => document.querySelectorAll('a[href*="/list_sales"]').length);
    if (i % 20 === 0) console.log(`round ${i}: count=${count}`);
    const found = await page.evaluate(() => !!document.querySelector('a[href*="5170199"]'));
    if (found) {
      console.log(`FOUND at round ${i}, count=${count}`);
      break;
    }
    if (count === lastCount) {
      stableStreak += 1;
      if (stableStreak >= 3) {
        console.log(`スクロール終端に達しました(round ${i}, count=${count})。見つかりませんでした。`);
        break;
      }
    } else {
      stableStreak = 0;
    }
    lastCount = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
  }

  const finalCount = await page.evaluate(() => document.querySelectorAll('a[href*="/list_sales"]').length);
  const found = await page.evaluate(() => !!document.querySelector('a[href*="5170199"]'));
  console.log(`最終: count=${finalCount}, 5170199発見=${found}`);
});
