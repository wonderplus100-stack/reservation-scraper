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
  if ((await endedTab.count().catch(() => 0)) > 0) {
    await endedTab.first().click().catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);
    for (let i = 0; i < 80; i += 1) {
      const found = await page.evaluate(() => !!document.querySelector('a[href*="5170199"]'));
      if (found) break;
      const before = await page.evaluate(() => document.querySelectorAll('a[href*="/list_sales"]').length);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => document.querySelectorAll('a[href*="/list_sales"]').length);
      if (after === before && i > 5) break; // これ以上読み込まれない
    }
  }
  console.log("url:", page.url());

  const groupsInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/group/"]')).map((a) => ({
      href: a.href,
      text: a.textContent.trim().slice(0, 80)
    }));
  });
  console.log("groups:", JSON.stringify(groupsInfo, null, 1));

  const info = await page.evaluate(() => {
    const link = document.querySelector('a[href*="5170199"]');
    if (!link) {
      const all = Array.from(document.querySelectorAll("h3.pod-event-name")).filter((h) =>
        h.textContent.includes("ENTERTAINMENT")
      );
      return { error: "5170199のリンクが見つかりません", entertainmentHeadingsFound: all.length, titles: all.map((h) => h.textContent.trim()) };
    }
    const card = link.closest("li");
    if (!card) return { error: "カード(li)が見つかりません" };
    const candidates = [];
    card.querySelectorAll("*").forEach((el) => {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join("");
      if (own && own.length > 1) {
        candidates.push({ tag: el.tagName, class: el.className, ownText: own.slice(0, 120) });
      }
    });
    return { candidates: candidates.slice(0, 40) };
  });
  console.log(JSON.stringify(info, null, 1));
});
