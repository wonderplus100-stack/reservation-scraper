import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const STORAGE_DIR = path.resolve("storage-state");
const PROFILE_DIR = path.resolve("browser-profiles");

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

// 常駐プロファイル方式: 普段使いのChromeと同じく、cookie・ローカル保存・
// 「このデバイスを記憶」等をプロファイルフォルダごと保持するので、保存済みの
// セッションファイルだけを読み込む方式より長くログインが維持されることを期待
// している。普段使いのChrome本体のプロファイルは、起動中はロックされ、
// 暗号化されたcookieも外から読めないため流用できない(専用フォルダに別途
// 1回ログインしてもらう)。Chrome本体(channel:"chrome")が無い環境では
// Playwright同梱のChromiumで代用する。
export function profileDirPath(accountLabel) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return path.join(PROFILE_DIR, slug(accountLabel));
}

export function hasProfile(accountLabel) {
  const dir = profileDirPath(accountLabel);
  return fs.existsSync(path.join(dir, "Default")) || fs.existsSync(path.join(dir, "Local State"));
}

export async function launchProfileContext(accountLabel, { headless, extra = {} } = {}) {
  const options = {
    headless,
    locale: "ja-JP",
    extraHTTPHeaders: { "Accept-Language": "ja-JP,ja;q=0.9" },
    ...extra
  };
  try {
    return await chromium.launchPersistentContext(profileDirPath(accountLabel), { channel: "chrome", ...options });
  } catch (err) {
    if (!/Executable doesn't exist|channel|chrome/i.test(String(err.message))) throw err;
    console.warn("Chrome本体が見つからないためPlaywright同梱のChromiumを使います:", err.message.split("\n")[0]);
    return chromium.launchPersistentContext(profileDirPath(accountLabel), options);
  }
}

// フォーム送信ボタンの正確なセレクタが分からなくても動くよう、
// まずEnterキーで送信を試み、それでも同じ入力欄が残っている場合は
// 同じフォーム内のボタンをクリックするフォールバックを行う。
export async function submitForm(page, inputLocator) {
  // 広告が多いサイトでは"networkidle"がいつまでも成立せず、送信自体は
  // 成功しているのに最大60秒近く待たされる実例が確認された(こくちーずPRO)。
  // 送信後の遷移確認はdomcontentloadedで十分なため、それに統一する。
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
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
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        fallbackButton.click()
      ]);
    }
  }
}

export async function withBrowser(accountLabel, fn, { persistent = false } = {}) {
  const headless = process.env.HEADLESS !== "false";
  if (persistent) {
    const hasSavedState = hasProfile(accountLabel);
    const context = await launchProfileContext(accountLabel, { headless });
    context.setDefaultTimeout(60000);
    context.setDefaultNavigationTimeout(60000);
    try {
      const page = context.pages()[0] || (await context.newPage());
      const result = await fn(page, { hasSavedState });
      await context.storageState({ path: storageStatePath(accountLabel) });
      return result;
    } finally {
      await context.close();
    }
  }
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
