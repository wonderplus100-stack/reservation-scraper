import { chromium } from "playwright";
import { storageStatePath } from "../lib/browser.mjs";

// つなげーとは(Peatix同様)パスワードログインを廃止し、メールアドレスのみで
// 認証メール経由のログインになった(2026年9月に画面確認: 「パスワードは
// 不要。メールアドレスだけでログインできます」)。このスクリプトはユーザーの
// 手元PCで画面付き(headed)ブラウザを開き、手動でログイン(認証メールの
// リンク/コードを含む)してもらった上で、そのログイン済みセッションを
// ファイルに保存する。
//
// 使い方:
//   node scripts/tunagate-manual-login.mjs "つなげーと"

const accountLabel = process.argv[2];
if (!accountLabel) {
  console.error('使い方: node scripts/tunagate-manual-login.mjs "アカウントラベル"');
  process.exit(1);
}

const statePath = storageStatePath(`tunagate-${accountLabel}`);

// 実際に確認したところ /mypage/management は404になっており、リダイレクトも
// 発生しないため「/users/sign_in にリダイレクトされないこと」では未ログイン
// を検知できなかった(常に「ログイン済み」と誤判定していた)。トップページに
// 「ログイン」リンクが残っているかどうかで判定する方が確実。
async function isLoggedIn(page) {
  await page.goto("https://tunagate.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  const hasLoginLink = await page
    .locator('a[href*="/users/sign_in"]')
    .first()
    .isVisible()
    .catch(() => false);
  return !hasLoginLink;
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("https://tunagate.com/users/sign_in");

  console.log("");
  console.log(`ブラウザで「${accountLabel}」としてつなげーとにログインしてください。`);
  console.log("(メールアドレスを入力し、届いた認証メールのリンク/コードでログインしてください)");
  console.log("ログインが完了して、マイページ等が表示されたら、");
  console.log("このターミナルに戻って Enter キーを押してください。");
  console.log("");

  for (;;) {
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", resolve);
    });

    if (await isLoggedIn(page)) break;

    console.log("");
    console.log(`ログイン済みの状態が確認できませんでした(現在のURL: ${page.url()})。`);
    console.log("マイページが表示されている状態で、もう一度Enterキーを押してください。");
    console.log("");
  }

  await context.storageState({ path: statePath });
  console.log(`ログイン済みであることを確認し、保存しました: ${statePath}`);

  await browser.close();
  process.exit(0);
}

main();
