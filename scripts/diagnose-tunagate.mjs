import "dotenv/config";
import { withBrowser } from "../lib/browser.mjs";

await withBrowser("tunagate-つなげーと", async (page, { hasSavedState }) => {
  if (!hasSavedState) {
    console.log("保存済みセッションがありません");
    return;
  }
  await page.goto("https://tunagate.com/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log("root url:", page.url());

  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ href: a.getAttribute("href"), text: a.textContent.trim().slice(0, 40) }))
      .filter((l) => l.href && !l.href.startsWith("http") || (l.href && l.href.includes("tunagate.com")))
      .filter((l) => l.text || l.href.includes("circle") || l.href.includes("mypage") || l.href.includes("management"));
  });
  console.log("links:", JSON.stringify(links.slice(0, 60), null, 1));
});
