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
  const context = await browser.newContext(hasSavedState ? { storageState: statePath } : {});
  const page = await context.newPage();
  try {
    const result = await fn(page, { hasSavedState });
    await context.storageState({ path: statePath });
    return result;
  } finally {
    await browser.close();
  }
}
