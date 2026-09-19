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
    for (let i = 0; i < 20; i += 1) {
      const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll("h3.pod-event-name")).some((h) => h.textContent.includes("ENTERTAINMENT"))
      );
      if (found) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  console.log("url:", page.url());

  const info = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h3.pod-event-name")).find((h) =>
      h.textContent.includes("ENTERTAINMENT")
    );
    if (!heading) return { error: "ENTERTAINMENTイベントの見出しが見つかりません" };
    const card = heading.closest("li");
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
