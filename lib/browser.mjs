import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const STORAGE_DIR = path.resolve("storage-state");

function slug(label) {
  return String(label || "account")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "account";
}

// アカウントごとにログイン済みセッション(cookie等)を保存/再利用する。
// 毎回ログインし直すと2段階認証が都度発生してしまうため、
// 一度ログインに成功したらセッションを使い回して負荷とリスクを減らす。
export function storageStatePath(accountLabel) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  return path.join(STORAGE_DIR, `${slug(accountLabel)}.json`);
}

// フォーム送信ボタンの正確なセレクタが分からなくても動くよう、
// まずEnterキーで送信を試み、それでも同じ入力欄が残っている場合は
// 同じフォーム内のボタンをクリックするフォールバックを行う。
export async function submitForm(page, inputLocator) {
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    inputLocator.press("Enter")
  ]);
  if (await inputLocator.isVisible().catch(() => false)) {
    const fallbackButton = page
      .locator("form")
      .filter({ has: inputLocator })
      .locator('button, input[type="submit"]')
      .first();
    if ((await fallbackButton.count()) > 0) {
      await Promise.all([
        page.waitForLoadState("networkidle").catch(() => {}),
        fallbackButton.click()
      ]);
    }
  }
}

export async function withBrowser(accountLabel, fn) {
  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const statePath = storageStatePath(accountLabel);
  const hasSavedState = fs.existsSync(statePath);
  // CI環境ではブラウザの既定ロケールが日本語にならず、サイトが英語UIを
  // 返してしまい、日本語のプレースホルダー("メール"等)を探すセレクタが
  // 一致しなくなる問題が実際に発生した(Peatixで確認)。日本語ロケールを
  // 明示することで、実際の日本在住ユーザーと同じ表示にする。
  const localeOptions = {
    locale: "ja-JP",
    extraHTTPHeaders: { "Accept-Language": "ja-JP,ja;q=0.9" }
  };
  const context = await browser.newContext(
    hasSavedState ? { storageState: statePath, ...localeOptions } : localeOptions
  );
  // 広告が多いイベント告知サイトはページ完全読み込み("load")に時間がかかり、
  // CI環境ではデフォルトの30秒を超えてタイムアウトすることがあるため延長する。
  context.setDefaultTimeout(60000);
  context.setDefaultNavigationTimeout(60000);
  const page = await context.newPage();
  try {
    const result = await fn(page, { hasSavedState });
    await context.storageState({ path: statePath });
    return result;
  } finally {
    await browser.close();
  }
}
