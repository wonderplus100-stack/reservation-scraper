import "dotenv/config";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readUpdateControl, writeUpdateControl } from "../lib/sheetsClient.mjs";
import { accountsFromEnv, ensureLoggedIn } from "../scrapers/peatix.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// ダッシュボードの「今すぐ更新」ボタン(Code.js requestPeatixUpdate)が
// UpdateControlシートに status="requested" を書き込むのを、このPC上で
// 常駐して数秒おきにポーリングし、検知したらPeatixの取得を実行する。
//
// 使い方:
//   node scripts/peatix-update-watcher.mjs
// 終了しない常駐プロセスなので、Windowsタスクスケジューラに
// 「ログオン時に開始」で登録するか、専用PCでターミナルを開いたままにする。

const POLL_INTERVAL_MS = 8000;
const sheetId = process.env.SHEET_ID;
if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

function runPeatixScrape() {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      process.execPath,
      ["run.mjs", "--only=peatix"],
      { cwd: projectRoot, timeout: 60 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || stdout || err.message));
          return;
        }
        resolve(stdout);
      }
    );
    proc.stdout?.on("data", (d) => process.stdout.write(d));
    proc.stderr?.on("data", (d) => process.stderr.write(d));
  });
}

async function handleUpdateRequest() {
  await writeUpdateControl(sheetId, { status: "running", message: "開始しました" });

  const accounts = accountsFromEnv();
  for (const account of accounts) {
    console.log(`[watcher] ${account.label} のログイン状態を確認します`);
    const result = await ensureLoggedIn(account.label, {
      onStatus: (message) => {
        console.log(`[watcher] ${message}`);
        writeUpdateControl(sheetId, { status: "running", message }).catch(() => {});
      }
    });
    if (!result.loggedIn) {
      await writeUpdateControl(sheetId, {
        status: "error",
        message: `「${account.label}」のログインがタイムアウトしました。もう一度「今すぐ更新」をお試しください。`
      });
      return;
    }
  }

  await writeUpdateControl(sheetId, { status: "running", message: "Peatixからデータを取得しています…" });
  try {
    const output = await runPeatixScrape();
    const summaryLine = output.split("\n").find((line) => line.startsWith("peatix:")) || "完了しました";
    await writeUpdateControl(sheetId, { status: "done", message: summaryLine.trim() });
  } catch (err) {
    await writeUpdateControl(sheetId, { status: "error", message: `取得に失敗しました: ${err.message.slice(0, 200)}` });
  }
}

async function loop() {
  console.log(`[watcher] 起動しました。${POLL_INTERVAL_MS / 1000}秒おきに更新リクエストを確認します。`);
  for (;;) {
    try {
      const control = await readUpdateControl(sheetId);
      if (control.status === "requested") {
        console.log("[watcher] 更新リクエストを検知しました");
        await handleUpdateRequest();
      }
    } catch (err) {
      console.error("[watcher] ポーリング中にエラー:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

loop();
