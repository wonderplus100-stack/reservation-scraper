import { launchProfileContext } from "../lib/browser.mjs";

// Wonder+公式サイト(WordPress)の管理画面に、自動取得用の専用Chromeプロファイルで
// ログインしておくためのスクリプト(scrapers/wpBookings.mjs が同じプロファイルを使う)。
// 画面付きのChromeが開くので、普段どおりログインするだけでよい。「予約」の一覧が
// 表示されたことを自動で検知して、保存して終了する。パスワードは保存・入力しない。
//
// 使い方: node scripts/wp-manual-login.mjs
const PROFILE_LABEL = "wonderplus-site";
const LIST_URL = "https://wonderplus.ne.jp/wp-admin/edit.php?post_type=booking";
const WAIT_LIMIT_MS = 15 * 60 * 1000;

async function main() {
  const context = await launchProfileContext(PROFILE_LABEL, { headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(LIST_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("");
  console.log("開いたChromeで、Wonder+公式サイトの管理画面にログインしてください。");
  console.log("「予約」の一覧が表示されたら、自動で検知して終了します(最大15分待ちます)。");
  console.log("");

  const deadline = Date.now() + WAIT_LIMIT_MS;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const url = page.url();
    if (await page.locator("table.wp-list-table td.column-status").count().catch(() => 0)) {
      done = true;
      break;
    }
    // ログイン後に別の管理画面(ダッシュボード等)へ移動した場合は、予約一覧を開き直す。
    if (/wonderplus\.ne\.jp\/wp-admin\//.test(url) && !/post_type=booking/.test(url)) {
      await page.goto(LIST_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  if (!done) {
    console.error("予約一覧を確認できないまま時間切れになりました。もう一度実行してください。");
    await context.close();
    process.exit(1);
  }
  console.log("ログイン済みを確認しました。以降の自動取得でこの状態を使います。");
  await context.close();
  process.exit(0);
}

main();
