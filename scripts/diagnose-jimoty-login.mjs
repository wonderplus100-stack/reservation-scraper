import "dotenv/config";
import { withBrowser } from "../lib/browser.mjs";

const email = process.env.JIMOTY_1_EMAIL;
const password = process.env.JIMOTY_1_PASSWORD;

await withBrowser("jimoty-ジモティ", async (page, { hasSavedState }) => {
  await page.goto("https://jmty.jp/my/posts", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  let loggedIn = !/\/users\/sign_in/.test(page.url());
  console.log("初回アクセス url:", page.url(), "ログイン済み:", loggedIn);

  if (!loggedIn) {
    if (!email || !password) {
      console.error("JIMOTY_1_EMAIL / JIMOTY_1_PASSWORD が未設定です");
      return;
    }
    await page.goto("https://jmty.jp/users/sign_in", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("例）email@jmty.jp").fill(email);
    await page.getByPlaceholder("●●●●●●●●").fill(password);
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      page.getByRole("button", { name: /ログイン/ }).click()
    ]);
    await page.waitForTimeout(1500);
    console.log("login後 url:", page.url());
  }

  await page.goto("https://jmty.jp/my/posts", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  await page.goto("https://jmty.jp/web_mail/posts/6aa15f3586821d046a0553ae/threads", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log("threads url:", page.url());
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log("bodyText:", bodyText);
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ href: a.getAttribute("href"), text: a.textContent.trim().slice(0, 40) }))
      .filter((l) => l.href && l.text);
  });
  console.log("threads links:", JSON.stringify(links.slice(0, 30), null, 1));
});
