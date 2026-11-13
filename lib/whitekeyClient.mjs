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
  // 途中で失敗したときにブラウザを閉じ忘れると、プロセスが終了せず、5分おきの自動実行が
  // 「実行中」のまま全て飛ばされてしまう(実際に発生した)。失敗時は必ず閉じる。
  try {
    const context = await browser.newContext({
      httpCredentials: { username: process.env.WHITEKEY_BASIC_USER, password: process.env.WHITEKEY_BASIC_PASSWORD },
      locale: "ja-JP"
    });
    context.setDefaultTimeout(60000);
    const page = await context.newPage();
    // サイトが一時的に遅いことがあるため、接続は数回試す。
    for (let attempt = 1; ; attempt += 1) {
      try {
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
      }
    }
    await page.fill('input[name="userId"]', process.env.WHITEKEY_USER_ID);
    await page.fill('input[name="password"]', process.env.WHITEKEY_PASSWORD);
    await page.click("#btnLogin");
    // ログイン後のメニュー(フォーム送信で画面が切り替わる)が出るまで待つ。
    await page.waitForSelector('span[name="btnPartyJokyo"]', { timeout: 30000 }).catch(() => {});
    if (!(await page.locator('span[name="btnPartyJokyo"]').count())) {
      throw new Error("whitekeyにログインできませんでした(IDまたはパスワードを確認してください)");
    }
    return { browser, context, page, close: () => browser.close() };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
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

// パーティーの受付済みの予約(姓名・きっかけ・予約状況)を、「詳細リスト表示」画面から読む。読み取り専用。
// 重複して入力しないための照合に使う。読み終わったら、メニュー経由でパーティー一覧に戻る
// (呼び出し側は、必要なら showDate で日付を表示し直す)。
export async function readRegistrants(page, partycode) {
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    // 画面上部の固定ヘッダーが重なってクリックできないことがあるため、スクリプトでクリックする。
    page.locator(`tr#trData_${partycode} a.detailOpen`).first().evaluate((el) => el.click())
  ]);
  await page.waitForSelector("table", { timeout: 60000 });
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll("tr")) {
      const tds = [...tr.children].filter((c) => c.tagName === "TD");
      if (tds.length < 30) continue;
      // 姓名のセルは、性別で class が man / woman になる。受付形態・きっかけ・予約状況は、その右隣に並ぶ。
      const nameIndex = tds.findIndex((c) => /(^|\s)(man|woman)(\s|$)/.test(c.className));
      if (nameIndex < 0) continue;
      const text = (i) => (tds[i]?.textContent || "").replace(/\s+/g, " ").trim();
      out.push({
        kana: text(nameIndex),
        gender: /woman/.test(tds[nameIndex].className) ? "女" : "男",
        keiyu: text(nameIndex + 12),
        status: text(nameIndex + 13)
      });
    }
    return out;
  });
  // 「TOPへ戻る」(#back)で、パーティー一覧(日付は今日に戻る)に戻る。
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#back").first().evaluate((el) => el.click());
  await page.waitForSelector('tr.trData, input[name="searchInputDate"]', { timeout: 60000 });
  return rows;
}
