import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SOURCE_STATUS_SHEET, readSheetAsObjects, readUpdateControl, writeUpdateControl, writeUpdateHeartbeat } from "../lib/sheetsClient.mjs";
import { accountsFromEnv, ensureLoggedIn } from "../scrapers/peatix.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// ダッシュボードの「データを更新」ボタン(Code.js の requestUpdate)が UpdateControl シートに
// status="requested"(と更新したい取得先 sources)を書き込むのを、このPC上で常駐して数秒おきに
// 見張り、頼まれた取得先だけ run.mjs --only=<取得先> で取得し直す。
// 結果は SourceStatus(取得状況)に run.mjs 自身が書くので、ダッシュボードの色にそのまま反映される。
//
// 使い方: node scripts/update-watcher.mjs  (終わらない常駐プロセス。scripts/install-update-watcher.ps1 でログオン時に自動起動できる)
// PCが止まっている間に押された依頼は、PCが起動して、このプログラムが動き出した時に処理される。
const POLL_INTERVAL_MS = 8000;
const HEARTBEAT_INTERVAL_MS = 60000;
const SCHEDULED_TASK_NAME = "WonderPlus-PeatixScrape"; // 2時間おきの定期取得(同じPeatixのブラウザを使うので、重ならないようにする)
const LOCK_FILE = path.join(projectRoot, "data", "manual-update.lock"); // 定期取得側(run-peatix-scheduled.cmd)が見て、重ならないよう待つ
const MAX_WAIT_FOR_SCHEDULED_MS = 100 * 60 * 1000;

const LABELS = {
  peatix: "Peatix",
  wpBookings: "公式サイト予約",
  evemado: "イベマド",
  jimoty: "ジモティ",
  googleForms: "Googleフォーム",
  kokuchpro: "こくちーず"
};
// 1取得先あたりの上限(run.mjs 側の上限より少し長く)
const TIMEOUT_MS = { peatix: 65, kokuchpro: 25, wpBookings: 25, jimoty: 25, evemado: 10, googleForms: 10 };

const sheetId = process.env.SHEET_ID;
if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

function runScrape(source) {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      process.execPath,
      ["run.mjs", `--only=${source}`],
      { cwd: projectRoot, timeout: (TIMEOUT_MS[source] || 30) * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || stdout || err.message).slice(-300))) : resolve(stdout))
    );
    proc.stdout?.on("data", (d) => process.stdout.write(d));
    proc.stderr?.on("data", (d) => process.stderr.write(d));
  });
}

function scheduledTaskRunning() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-ScheduledTask -TaskName '${SCHEDULED_TASK_NAME}' -ErrorAction SilentlyContinue).State`],
      (err, stdout) => resolve(!err && /Running/i.test(String(stdout)))
    );
  });
}

// この取得先が、今回の依頼の後に取得結果を記録できたか(SourceStatusで確かめる)。
async function checkResult(source, startedAt) {
  const rows = (await readSheetAsObjects(sheetId, SOURCE_STATUS_SHEET).catch(() => [])).filter((r) => r.platform === source);
  const fresh = rows.filter((r) => Date.parse(r.lastAttemptAt || "") >= startedAt - 1000);
  if (fresh.length === 0) return { ok: false, reason: "取得結果が記録されませんでした" };
  const bad = fresh.filter((r) => r.status !== "ok");
  if (bad.length > 0) return { ok: false, reason: String(bad[0].message || "取得に失敗しました").slice(0, 120) };
  return { ok: true };
}

async function handleUpdateRequest() {
  const control = await readUpdateControl(sheetId);
  const sources = String(control.sources || "peatix")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => LABELS[s]);
  if (sources.length === 0) {
    await writeUpdateControl(sheetId, { status: "error", message: "更新する取得先が分かりませんでした。もう一度選んでください。" });
    return;
  }
  const names = sources.map((s) => LABELS[s]).join("・");
  await writeUpdateControl(sheetId, { status: "running", message: `${names} の更新を始めます` });

  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, new Date().toISOString());
  const failures = [];
  try {
    // Peatixは定期取得と同じブラウザを使うため、定期取得の実行中は待つ。
    if (sources.includes("peatix")) {
      const waitStart = Date.now();
      while ((await scheduledTaskRunning()) && Date.now() - waitStart < MAX_WAIT_FOR_SCHEDULED_MS) {
        await writeUpdateControl(sheetId, { status: "running", message: "定期の自動更新が実行中です。終わり次第、始めます" });
        await writeUpdateHeartbeat(sheetId).catch(() => {});
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
    for (const [i, source] of sources.entries()) {
      const label = LABELS[source];
      const step = `(${i + 1}/${sources.length})`;
      if (source === "peatix") {
        let loginOk = true;
        for (const account of accountsFromEnv()) {
          await writeUpdateControl(sheetId, { status: "running", message: `${step} Peatix「${account.label}」のログインを確認しています` });
          const result = await ensureLoggedIn(account.label, {
            timeoutMs: 10 * 60 * 1000,
            onStatus: (message) => writeUpdateControl(sheetId, { status: "running", message }).catch(() => {})
          });
          if (!result.loggedIn) {
            failures.push(`Peatix「${account.label}」のログインが切れています(PCでログインしてください)`);
            loginOk = false;
          }
        }
        if (!loginOk) continue;
      }
      await writeUpdateControl(sheetId, { status: "running", message: `${step} ${label}を取得しています…` });
      const startedAt = Date.now();
      try {
        await runScrape(source);
        const result = await checkResult(source, startedAt);
        if (!result.ok) failures.push(`${label}: ${result.reason}`);
      } catch (err) {
        failures.push(`${label}: ${err.message.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
  if (failures.length === 0) {
    await writeUpdateControl(sheetId, { status: "done", message: `${names} の更新が完了しました` });
  } else {
    await writeUpdateControl(sheetId, { status: "error", message: `更新できなかったものがあります: ${failures.join(" / ")}` });
  }
}

async function loop() {
  console.log(`[update-watcher] 起動しました。${POLL_INTERVAL_MS / 1000}秒おきに更新リクエストを確認します。`);
  let lastBeat = 0;
  for (;;) {
    try {
      if (Date.now() - lastBeat > HEARTBEAT_INTERVAL_MS) {
        await writeUpdateHeartbeat(sheetId);
        lastBeat = Date.now();
      }
      const control = await readUpdateControl(sheetId);
      if (control.status === "requested") {
        console.log(`[update-watcher] 更新リクエストを検知しました: ${control.sources}`);
        await handleUpdateRequest();
        lastBeat = 0;
      } else if (control.status === "running") {
        // 前回、この受付プログラムが途中で止まった(PCの再起動など)ままの状態。誰も処理していないので、解除する。
        const age = Date.now() - Date.parse(control.updatedAt || "");
        if (age > 100 * 60 * 1000) {
          await writeUpdateControl(sheetId, { status: "error", message: "前回の更新が途中で止まりました。もう一度更新してください" });
        }
      }
    } catch (err) {
      console.error("[update-watcher] ポーリング中にエラー:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

loop();
