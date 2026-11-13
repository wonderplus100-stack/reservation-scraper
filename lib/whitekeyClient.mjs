import { chromium } from "playwright";

// whitekey(会員・パーティー管理システム)の管理画面を操作する部品。
// 認証は二重: ①サイトに入るときのBasic認証 ②画面上のログインフォーム。
// 値は .env の WHITEKEY_BASIC_USER / WHITEKEY_BASIC_PASSWORD / WHITEKEY_USER_ID / WHITEKEY_PASSWORD。
// 画面が古い作りでも、ブラウザを自動操作するだけなのでIE Tabは要らない。
//
// このファイルの「読み取り」系(login / readParties)は画面を見るだけで何も変更しない。
// 「受付」ボタンを押すと対応中の状態になるため、読み取りでは押さない。
const BASE = "http://whitekey.co.jp/admin/";

export async function openWhitekey({ headless = true } = {}) {
  for (const key of ["WHITEKEY_BASIC_USER", "WHITEKEY_BASIC_PASSWORD", "WHITEKEY_USER_ID", "WHITEKEY_PASSWORD"]) {
    if (!process.env[key]) throw new Error(`環境変数 ${key} が設定されていません(.env に入力してください)`);
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    httpCredentials: { username: process.env.WHITEKEY_BASIC_USER, password: process.env.WHITEKEY_BASIC_PASSWORD },
    locale: "ja-JP"
  });
  context.setDefaultTimeout(60000);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="userId"]', process.env.WHITEKEY_USER_ID);
  await page.fill('input[name="password"]', process.env.WHITEKEY_PASSWORD);
  await page.click("#btnLogin");
  // ログイン後のメニュー(フォーム送信で画面が切り替わる)が出るまで待つ。
  await page.waitForSelector('span[name="btnPartyJokyo"]', { timeout: 30000 }).catch(() => {});
  if (!(await page.locator('span[name="btnPartyJokyo"]').count())) {
    await browser.close();
    throw new Error("whitekeyにログインできませんでした(IDまたはパスワードを確認してください)");
  }
  return { browser, context, page, close: () => browser.close() };
}

// メニューから「パーティー受付状況一覧」を開く(今日の日付で表示される)。
export async function openPartyList(page) {
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.locator('span[name="btnPartyJokyo"]').locator("xpath=ancestor::a").click()
  ]);
  await page.waitForSelector("tr.trData", { timeout: 60000 }).catch(() => {});
}

// 一覧の日付を切り替える(YYYY/MM/DD)。
export async function showDate(page, ymd) {
  await page.fill('input[name="searchInputDate"]', ymd);
  await Promise.all([page.waitForLoadState("domcontentloaded"), page.click("#search")]);
  await page.waitForSelector("tr.trData", { timeout: 60000 }).catch(() => {});
}

// 一覧に出ているパーティー(会場・時間・タイトル・状況)を読む。受付ボタンは押さない。
export async function readParties(page) {
  return page.evaluate(() => {
    const parties = [];
    for (const upper of document.querySelectorAll("tr.trData")) {
      const code = upper.querySelector("span.partycode")?.textContent.trim();
      if (!code) continue; // 2段目(下段)の行は partycode を持たない
      // 1パーティーは2行(上段=状況・時間・会場、下段=規模・タイトル)。下段は直後の行。
      const lower = upper.nextElementSibling;
      const areaKey = upper.querySelector("span.trData_key")?.textContent.trim() || "";
      parties.push({
        partycode: code,
        area: areaKey.replace(/_\d+$/, ""), // 例: area_12(都市の区分)
        status: upper.querySelector("span.partystatusname")?.textContent.trim() || "",
        time: (upper.querySelector(".kaisaitime_start")?.textContent || "").replace(/\s| /g, ""),
        hall: (upper.querySelector("a.mapview")?.textContent || "").trim(),
        // タイトル欄は、下段の「規模(.kibo)」セルの次のセル。
        title: (lower?.querySelector("td.kibo")?.nextElementSibling?.textContent || "").replace(/\s+/g, " ").trim(),
        hasReceptionButton: Boolean(upper.querySelector(".btn_rece")),
        // 完了人数(上段=男性、下段=女性)。登録後に増えたかの確認に使う。
        doneMen: Number((upper.querySelector("td.cell_men_fin")?.textContent || "").replace(/[^\d]/g, "")) || 0,
        doneWomen: Number((lower?.querySelector("td.cell_women_fin")?.textContent || "").replace(/[^\d]/g, "")) || 0,
        rowId: upper.id
      });
    }
    return parties;
  });
}
