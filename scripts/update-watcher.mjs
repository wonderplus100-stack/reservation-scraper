import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
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

// ---- 最新のプログラムの取り込みと、自動の再起動 ----
// 依頼を受けるたび(と、待機中は30分おき)に git pull で最新のプログラムを取り込む。
// この受付プログラム自身(や、読み込んでいる部品)が変わった時は、終了して、起動用のcmd(run-update-watcher.cmd)に
// 立ち上げ直してもらう。取得(run.mjs)は毎回別プロセスなので、pull するだけで最新のプログラムが使われる。
const STARTED_AT = new Date().toISOString();
const RESTART_EXIT_CODE = 75;
const IDLE_PULL_INTERVAL_MS = 30 * 60 * 1000;
const RELOAD_FILES = /^(scripts\/update-watcher\.mjs|lib\/|scrapers\/peatix\.mjs|package(-lock)?\.json)/;

function git(args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: projectRoot, timeout: 120000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}
const shortHead = async () => ((await git(["rev-parse", "--short", "HEAD"])) || "").slice(0, 8);
let loadedHead = "";

// 取り込めなかった時(手元に変更がある・通信できない等)は、何もせず今のプログラムで続ける。
async function pullLatest() {
  const before = await shortHead();
  await git(["pull", "--ff-only", "--quiet"]);
  const after = await shortHead();
  if (before && after && before !== after) {
    console.log(`[update-watcher] 最新のプログラムを取り込みました: ${before} → ${after}`);
    const changed = ((await git(["diff", "--name-only", before, after])) || "").split(/\r?\n/);
    if (changed.some((f) => /^package(-lock)?\.json$/.test(f))) {
      await new Promise((resolve) => execFile("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: projectRoot, shell: true, timeout: 10 * 60 * 1000 }, () => resolve()));
    }
  }
}

// 起動した時点の版から今の版までの間に、この受付プログラムに関わるファイルが変わったか。
async function needsRestart() {
  const head = await shortHead();
  if (!loadedHead || !head || head === loadedHead) return false;
  const changed = ((await git(["diff", "--name-only", loadedHead, head])) || "").split(/\r?\n/);
  return changed.some((f) => RELOAD_FILES.test(f));
}

async function heartbeat() {
  const head = await shortHead();
  await writeUpdateHeartbeat(sheetId, JSON.stringify({ host: os.hostname(), loaded: loadedHead, head, startedAt: STARTED_AT }));
}

// 取得は別プロセス(run.mjs)で行う。この受付プログラムは常駐していて、起動時の .env の値を環境変数として
// 持っているため、そのまま渡すと、後から .env を直しても(シート名の変更など)取得側に反映されない。
// .env に書かれている項目は子プロセスに渡さず、取得のたびに .env を読み直させる。
function freshChildEnv() {
  const env = { ...process.env };
  try {
    for (const key of Object.keys(dotenv.parse(fs.readFileSync(path.join(projectRoot, ".env"))))) delete env[key];
  } catch {
    // .env が無ければ、そのまま
  }
  return env;
}

function runScrape(source) {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      process.execPath,
      ["run.mjs", `--only=${source}`],
      { cwd: projectRoot, env: freshChildEnv(), timeout: (TIMEOUT_MS[source] || 30) * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
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
  loadedHead = await shortHead();
  console.log(`[update-watcher] 起動しました(プログラムの版 ${loadedHead || "不明"})。${POLL_INTERVAL_MS / 1000}秒おきに更新リクエストを確認します。`);
  let lastBeat = 0;
  let lastPull = Date.now();
  for (;;) {
    try {
      if (Date.now() - lastBeat > HEARTBEAT_INTERVAL_MS) {
        await heartbeat();
        lastBeat = Date.now();
      }
      const control = await readUpdateControl(sheetId);
      if (control.status === "requested") {
        console.log(`[update-watcher] 更新リクエストを検知しました: ${control.sources}`);
        await pullLatest();
        lastPull = Date.now();
        if (await needsRestart()) {
          // 依頼は「requested」のまま残るので、立ち上げ直した受付プログラムが処理する。
          console.log("[update-watcher] 受付プログラムが更新されたため、再起動します");
          process.exit(RESTART_EXIT_CODE);
        }
        await handleUpdateRequest();
        lastBeat = 0;
      } else if (control.status !== "running" && Date.now() - lastPull > IDLE_PULL_INTERVAL_MS) {
        await pullLatest();
        lastPull = Date.now();
        if (await needsRestart()) {
          console.log("[update-watcher] 受付プログラムが更新されたため、再起動します");
          process.exit(RESTART_EXIT_CODE);
        }
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
