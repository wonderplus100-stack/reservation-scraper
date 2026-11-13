import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  OFFICIAL_EVENTS_SHEET,
  RAW_DATA_SHEET,
  appendWhitekeyLedger,
  readPlatformEventMap,
  readSheetAsObjects,
  readWhitekeyLedger,
  replaceWhitekeyPending,
  updateSourceStatus
} from "../lib/sheetsClient.mjs";
import { fetchEventPostIds } from "../lib/eventPrices.mjs";
import { buildEntries, isUpcoming } from "../lib/whitekeyPlan.mjs";
import { annotateParties, matchParty } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, showDate } from "../lib/whitekeyClient.mjs";
import { fillRegistration, leaveWithoutRegistering, openRegistration, readBackRegistration, submitRegistration } from "../lib/whitekeyEntry.mjs";
import { collectForEvents } from "../scrapers/wpBookings.mjs";
import { collectForPlatformEventIds } from "../scrapers/kokuchpro.mjs";

// 開始の35分前までに、その時点の全予約をwhitekeyの受付登録に入れる。専用PCのタスクスケジューラで5分おきに実行する。
//  - 開始の35分前〜開始までのパーティー(=「入力の時間帯」)が対象。まず最新の予約を取り直し、
//    台帳(WhitekeyLedger)に無い予約だけを入力する(二重入力しない)。時間帯の間に増えた予約も、次回の実行で入る。
//  - whitekeyに該当パーティーが無い予約は入れず、未入力一覧(WhitekeyPending)に残してダッシュボードに出す。
//  - 登録(書き込み)は --commit または WHITEKEY_COMMIT=true のときだけ。それ以外は「入れる予定」を表示するだけ。
//  - 動かすPCは1台だけにする: .env に WHITEKEY_ENABLED=true があるPCでのみ動く(他のPCは何もしない)。
//
// 使い方: node scripts/whitekey-sync.mjs [--commit] [--lead=35] [--now=2026-11-30T19:00] [--event=<公式イベントID>] [--limit=N]
//   --event / --now: 時間帯でなくても、そのイベントを対象にする(試験用)。--limit: 1回に入れる最大件数。
const LEAD_MINUTES_DEFAULT = 35;
const PENDING_REFRESH_MS = 60 * 60 * 1000;
const RUNNER = "このPC";

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

function eventStart(event, now) {
  const [h, m] = String(event.time).split(":").map(Number);
  return new Date(now.getFullYear(), Number(event.month) - 1, Number(event.day), h, m || 0);
}

async function reportStatus(sheetId, { ok, message, rowCount }) {
  try {
    await updateSourceStatus(sheetId, [
      { platform: "whitekey", account: "自動入力", status: ok ? "ok" : "error", lastAttemptAt: new Date().toISOString(), rowCount, message: message || "", runner: RUNNER }
    ]);
  } catch (err) {
    console.warn("SourceStatus の更新に失敗しました:", err.message);
  }
}

// 未入力一覧の作り直し(1時間に1回まで): これから150日以内の予約のうち、whitekeyにパーティーが無いもの。
async function refreshPending({ sheetId, raw, official, ledger, wk }) {
  const stamp = path.resolve("data", "whitekey-pending-at.txt");
  try {
    if (Date.now() - Number(fs.readFileSync(stamp, "utf8")) < PENDING_REFRESH_MS) return;
  } catch {}
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { entries } = await buildEntries({ raw, official, ledger, sources: ["kokuchpro", "wpBookings"], eventFilter: (e) => isUpcoming(e, today) });
  const partiesByDate = new Map();
  const pending = [];
  for (const entry of entries) {
    let date = new Date(today.getFullYear(), Number(entry.month) - 1, Number(entry.day));
    if (date < today) date = new Date(today.getFullYear() + 1, Number(entry.month) - 1, Number(entry.day));
    const key = ymd(date);
    if (!partiesByDate.has(key)) {
      await showDate(wk.page, key);
      partiesByDate.set(key, annotateParties(await readParties(wk.page)));
    }
    const { state } = matchParty(entry, partiesByDate.get(key));
    if (state !== "一致") {
      pending.push({ eventDate: key, venue: entry.venue, time: entry.time, platform: entry.platform, name: entry.originalName, reason: state, bookingKey: entry.bookingKey, updatedAt: new Date().toISOString() });
    }
  }
  await replaceWhitekeyPending(sheetId, pending);
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, String(Date.now()));
  console.log(`未入力一覧を更新しました: ${pending.length}件`);
}

async function main() {
  if (process.env.WHITEKEY_ENABLED !== "true") {
    console.log("このPCではwhitekey自動入力は無効です(.env の WHITEKEY_ENABLED=true で有効。動かすPCは1台だけにしてください)。");
    return;
  }
  const sheetId = process.env.SHEET_ID;
  const commit = process.argv.includes("--commit") || process.env.WHITEKEY_COMMIT === "true";
  const lead = Number(arg("lead")) || LEAD_MINUTES_DEFAULT;
  const now = arg("now") ? new Date(arg("now")) : new Date();
  const forcedEvent = arg("event");
  const limit = Number(arg("limit")) || 40; // 1回に入れる最大件数(想定外の大量入力を防ぐ上限)

  const [official, raw, ledger, platformEventMap] = await Promise.all([
    readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET),
    readSheetAsObjects(sheetId, RAW_DATA_SHEET),
    readWhitekeyLedger(sheetId),
    readPlatformEventMap(sheetId)
  ]);

  // 入力の時間帯にあるイベント: 開始の lead 分前 〜 開始まで(今日のもの)
  const due = official.filter((e) => {
    if (forcedEvent) return e.canonicalEventId === forcedEvent;
    if (Number(e.month) !== now.getMonth() + 1 || Number(e.day) !== now.getDate()) return false;
    const start = eventStart(e, now);
    return now >= new Date(start.getTime() - lead * 60000) && now < start;
  });
  const dueIds = new Set(due.map((e) => e.canonicalEventId));
  console.log(`[${now.toLocaleString("ja-JP")}] 入力の時間帯のイベント: ${due.length}件 / ${commit ? "登録する" : "予定を表示するだけ(登録しない)"}`);

  let wk = null;
  let entered = 0;
  const notes = [];
  try {
    // 1. 最新の予約を取り直す(失敗しても、直近のRawDataで続ける)
    let overlay = raw;
    if (due.length > 0) {
      const fresh = [];
      const freshPlatformEventIds = new Set();
      let wpFresh = false;
      try {
        const postIds = await fetchEventPostIds(dueIds);
        const events = [...postIds].map(([canonicalEventId, postId]) => ({ canonicalEventId, postId }));
        if (events.length > 0) {
          fresh.push(...(await collectForEvents(events)));
          wpFresh = true;
        }
      } catch (err) {
        notes.push(`公式サイト予約の最新化に失敗(直近の取得データで続行): ${err.message}`);
      }
      const kokuchproIds = platformEventMap.filter((m) => m.platform === "kokuchpro" && dueIds.has(m.officialEventId));
      if (kokuchproIds.length > 0) {
        try {
          const rows = await collectForPlatformEventIds(kokuchproIds.map((m) => m.platformEventId));
          for (const row of rows) {
            row.canonicalEventId = kokuchproIds.find((m) => m.platformEventId === row.platformEventId)?.officialEventId;
            freshPlatformEventIds.add(row.platformEventId);
            fresh.push(row);
          }
        } catch (err) {
          notes.push(`こくちーずの最新化に失敗(直近の取得データで続行): ${err.message}`);
        }
      }
      overlay = raw.filter((r) => {
        if (wpFresh && r.platform === "wpBookings" && dueIds.has(r.canonicalEventId)) return false;
        if (r.platform === "kokuchpro" && freshPlatformEventIds.has(r.platformEventId)) return false;
        return true;
      }).concat(fresh);
      notes.forEach((n) => console.warn(n));
    }

    // 2. 入れる内容を組み立てる(台帳にある予約は除く)
    const { entries } = await buildEntries({ raw: overlay, official, ledger, sources: ["kokuchpro", "wpBookings"], eventFilter: (e) => dueIds.has(e.canonicalEventId) });
    console.log(`未入力の予約: ${entries.length}件`);

    // 3. whitekeyにログインして、パーティーを探して入力する
    wk = await openWhitekey();
    await openPartyList(wk.page);
    const today = ymd(forcedEvent && due[0] ? new Date(now.getFullYear(), Number(due[0].month) - 1, Number(due[0].day)) : now);
    if (entries.length > 0) await showDate(wk.page, today);
    let parties = annotateParties(await readParties(wk.page));
    const ledgerRows = [];
    let stopped = "";
    for (const entry of entries) {
      if (entered >= limit || stopped) break;
      const { party, state } = matchParty(entry, parties);
      if (!party) {
        console.log(`  - 入れられません(${state}): ${entry.originalName} ${entry.month}/${entry.day} ${entry.venue} ${entry.time}`);
        continue;
      }
      const summary = `${entry.originalName} → ${entry.people.map((p) => p.sei + p.mei).join("+")} / ${entry.venue} ${entry.time} / ${entry.fee}円 / ${entry.keiyu.label}`;
      if (!commit) {
        console.log(`  - 入れる予定: ${summary} (${party.partycode})`);
        continue;
      }
      const before = party;
      try {
        await openRegistration(wk.page, party.partycode);
        await fillRegistration(wk.page, entry);
        const back = await readBackRegistration(wk.page, entry.people.length);
        if (!back.registerEnabled || back.people[0].sei !== entry.people[0].sei) throw new Error("入力内容を画面で確認できませんでした");
        const result = await submitRegistration(wk.page, { commit });
        console.log(`  - 登録しました: ${summary} / 確認ダイアログ: ${result.dialogs.join(" | ")}`);
        // 登録ボタンを押した時点で台帳に記録する(このあとの確認が失敗しても、同じ予約を二重に入れないため)。
        const ledgerRow = {
          bookingKey: entry.bookingKey, partycode: party.partycode, eventDate: `${entry.month}/${entry.day}`, venue: entry.venue, time: entry.time,
          platform: entry.platform, name: entry.originalName, sei: entry.people[0].sei, meiNumber: Math.max(...entry.people.map((p) => p.meiNumber || 0)),
          people: entry.people.length, fee: entry.fee, enteredAt: new Date().toISOString(), runner: RUNNER
        };
        await appendWhitekeyLedger(sheetId, [ledgerRow]);
        ledger[entry.bookingKey] = ledgerRow;
        entered += 1;
        // 一覧に戻り、完了人数が増えたかで登録を確認する
        if (!(await wk.page.locator('input[name="searchInputDate"]').count())) await leaveWithoutRegistering(wk.page);
        await showDate(wk.page, today);
        parties = annotateParties(await readParties(wk.page));
        const after = parties.find((p) => p.partycode === party.partycode);
        const increase = entry.sexkbn === "2" ? after.doneWomen - before.doneWomen : after.doneMen - before.doneMen;
        if (increase < entry.people.length) throw new Error(`登録後に完了人数が増えていません(増加${increase}/期待${entry.people.length})`);
      } catch (err) {
        stopped = err.message;
        console.error(`  ! 入力に失敗したため、このあとの入力を止めます: ${err.message} (${entry.originalName})`);
        try { await leaveWithoutRegistering(wk.page); } catch {}
      }
    }
    // 4. 未入力一覧の更新(1時間に1回まで)
    try {
      await refreshPending({ sheetId, raw: overlay, official, ledger, wk });
    } catch (err) {
      console.warn("未入力一覧の更新に失敗しました:", err.message);
    }
    const ok = !stopped;
    await reportStatus(sheetId, { ok, rowCount: entered, message: stopped || notes.join(" / ") });
    console.log(`完了: 登録${entered}件${stopped ? " / 停止: " + stopped : ""}`);
    if (stopped) process.exitCode = 1;
  } catch (err) {
    console.error("whitekey自動入力でエラー:", err.message);
    await reportStatus(sheetId, { ok: false, rowCount: entered, message: err.message });
    process.exitCode = 1;
  } finally {
    if (wk) await wk.close();
  }
}

main();
