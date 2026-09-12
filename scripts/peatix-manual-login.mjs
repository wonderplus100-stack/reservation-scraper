import { chromium } from "playwright";
import { storageStatePath } from "../lib/browser.mjs";

// Peatixはパスワードのみでの自動ログインを受け付けず、毎回メール確認
// (ワンタイムコード)を要求する仕様のため、GitHub Actions側からの
// 完全自動ログインはできない。このスクリプトはユーザーの手元のPCで
// 実際に画面付き(headed)ブラウザを開き、手動でログイン(メール確認を
// 含む)してもらった上で、そのログイン済みセッションをファイルに保存する。
// 保存したファイルの中身をGitHub Secretsに登録し、ワークフロー側で
// storage-state/以下に書き戻すことで、GitHub Actions側は「保存済みの
// ログイン済みセッションを使い回すだけ」で済むようにする。
//
// 使い方:
//   npx playwright install chromium   (初回のみ)
//   node scripts/peatix-manual-login.mjs "Wonder Plus"
//   node scripts/peatix-manual-login.mjs "Jua Party"
//
// 実行するとブラウザが開くので、そのままPeatixに普段通りログインして
// ください(メール確認コードの入力を含む)。ログインが完了して
// マイイベント画面が表示されたら、このターミナルに戻ってEnterキーを
// 押してください。

const accountLabel = process.argv[2];
if (!accountLabel) {
  console.error('使い方: node scripts/peatix-manual-login.mjs "アカウントラベル"');
  console.error('例: node scripts/peatix-manual-login.mjs "Wonder Plus"');
  process.exit(1);
}

// scrapers/peatix.mjs の withBrowser(`peatix-${account.label}`, ...) と
// 同じファイル名になるようにする。
const statePath = storageStatePath(`peatix-${accountLabel}`);

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("https://peatix.com/signin");

  console.log("");
  console.log(`ブラウザで「${accountLabel}」としてPeatixにログインしてください。`);
  console.log("(メール確認コードの入力が必要な場合はそれも行ってください)");
  console.log("ログインが完了して、マイイベント画面等が表示されたら、");
  console.log("このターミナルに戻って Enter キーを押してください。");
  console.log("");

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });

  await context.storageState({ path: statePath });
  console.log(`保存しました: ${statePath}`);
  console.log("このファイルの中身をコピーして、GitHub Secretsに登録してください。");

  await browser.close();
  process.exit(0);
}

main();
