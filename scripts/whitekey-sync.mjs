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
import { annotateParties, findDuplicate, matchParty } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, readRegistrants, showDate } from "../lib/whitekeyClient.mjs";
import { fillRegistration, leaveWithoutRegistering, openRegistration, readBackRegistration, submitRegistration } from "../lib/whitekeyEntry.mjs";
import { collectForEvents } from "../scrapers/wpBookings.mjs";
import { collectForPlatformEventIds } from "../scrapers/kokuchpro.mjs";
import { collectForPeatixEvents } from "../scrapers/peatix.mjs";
import { peatixCategoryOf } from "../lib/whitekeyRules.mjs";
import { dueSlots, eventStart, readStamps, writeStamps } from "../lib/whitekeySchedule.mjs";
import { warmDashboardCache } from "../lib/dashboardWarm.mjs";

// whitekeyの受付登録への自動入力(リスト更新)。専用PCのタスクスケジューラが5分おきに呼び出し、
// lib/whitekeySchedule.mjs のスケジュールに当たったイベントだけを処理する:
//   夜20時(当日+曜日ごとの範囲) / 当日の朝9時 / 当日のイベントの開始30分前 / 開始5分前
//  - 対象のイベントについて、まず最新の予約を取り直し、台帳(WhitekeyLedger)に無い予約だけを入力する(二重入力しない)。
//  - whitekeyに該当パーティーが無い予約は入れず、未入力一覧(WhitekeyPending)に残してダッシュボードに出す。
//  - 登録(書き込み)は --commit または WHITEKEY_COMMIT=true のときだけ。それ以外は「入れる予定」を表示するだけ。
//  - 動かすPCは1台だけにする: .env に WHITEKEY_ENABLED=true があるPCでのみ動く(他のPCは何もしない)。
//
// 使い方: node scripts/whitekey-sync.mjs [--commit] [--now=2026-11-30T20:00] [--event=<公式イベントID>] [--limit=N]
//   --event: スケジュールに関係なく、そのイベントを対象にする(試験用)。--now: 時刻を指定して確認する(記録はしない)。
const PENDING_REFRESH_MS = 60 * 60 * 1000;
const RUNNER = "このPC";
// 入力する取得先。Peatixは、カフェ会系・朝活・レギュラー異業種交流会のイベントだけ(lib/whitekeyRules.mjs)。
const SOURCES = ["kokuchpro", "wpBookings", "peatix"];

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

async function reportStatus(sheetId, { ok, message, rowCount }) {
  try {
    await updateSourceStatus(sheetId, [
      { platform: "whitekey", account: "自動入力", status: ok ? "ok" : "error", lastAttemptAt: new Date().toISOString(), rowCount, message: message || "", runner: RUNNER }
    ]);
  } catch (err) {
    console.warn("SourceStatus の更新に失敗しました:", err.message);
  }
}

const PENDING_STAMP = path.resolve("data", "whitekey-pending-at.txt");
function pendingIsStale() {
  try {
    return Date.now() - Number(fs.readFileSync(PENDING_STAMP, "utf8")) >= PENDING_REFRESH_MS;
  } catch {
    return true;
  }
}

// 未入力一覧の作り直し(1時間に1回まで): これから150日以内の予約のうち、whitekeyにパーティーが無いもの。
async function refreshPending({ sheetId, raw, official, ledger, wk }) {
  const stamp = PENDING_STAMP;
  if (!pendingIsStale()) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { entries } = await buildEntries({ raw, official, ledger, sources: SOURCES, eventFilter: (e) => isUpcoming(e, today) });
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
  // 何かが固まっても、次の5分おきの実行を妨げないよう、15分で必ず終了する(タスクの二重起動防止は
  // 「実行中なら飛ばす」設定のため、固まったまま残ると以降の自動入力が全て止まる)。
  setTimeout(() => {
    console.error("whitekey自動入力: 15分を超えたため強制終了します");
    process.exit(2);
  }, 15 * 60 * 1000).unref();
  const sheetId = process.env.SHEET_ID;
  const commit = process.argv.includes("--commit") || process.env.WHITEKEY_COMMIT === "true";
  const now = arg("now") ? new Date(arg("now")) : new Date();
  const forcedEvent = arg("event");
  const limit = Number(arg("limit")) || 40; // 1回に入れる最大件数(想定外の大量入力を防ぐ上限)

  const [official, raw, ledger, platformEventMap] = await Promise.all([
    readSheetAsObjects(sheetId, OFFICIAL_EVENTS_SHEET),
    readSheetAsObjects(sheetId, RAW_DATA_SHEET),
    readWhitekeyLedger(sheetId),
    readPlatformEventMap(sheetId)
  ]);

  // いま実行すべき枠(夜20時 / 朝9時 / 開始30分前 / 開始5分前)に当たるイベント
  const simulated = Boolean(arg("now")) || Boolean(forcedEvent);
  const stamps = readStamps();
  const { events: dueEventIds, keys: slotKeys, slots } = forcedEvent
    ? { events: new Set([forcedEvent]), keys: [], slots: ["指定イベント"] }
    : dueSlots(official, now, stamps);
  const due = official.filter((e) => dueEventIds.has(e.canonicalEventId));
  const dueIds = new Set(due.map((e) => e.canonicalEventId));
  const markDone = () => { if (!simulated && slotKeys.length > 0) writeStamps(stamps, slotKeys, now); };
  console.log(`[${now.toLocaleString("ja-JP")}] 実行する枠: ${slots.join(" / ") || "なし"} / 対象イベント: ${due.length}件 / ${commit ? "登録する" : "予定を表示するだけ(登録しない)"}`);

  // 対象のイベントが無く、未入力一覧の更新も不要なら、whitekeyにはログインしない。
  if (due.length === 0 && !pendingIsStale()) {
    markDone();
    // 動いていることがダッシュボードで分かるよう、「確認した時刻」だけは記録する。
    await reportStatus(sheetId, { ok: true, rowCount: 0, message: "" });
    return;
  }

  let wk = null;
  let entered = 0;
  let duplicates = 0;
  const notes = [];
  try {
    // 1. 最新の予約を取り直す(失敗しても、直近のRawDataで続ける)
    let overlay = raw;
    if (due.length > 0) {
      const fresh = [];
      const freshPlatformEventIds = new Set();
      const freshPeatixIds = new Set();
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
      // Peatix: 入力対象の種別(カフェ会系・朝活・レギュラー)のイベントだけ、その場で取り直す。
      const eligiblePeatix = platformEventMap.filter(
        (m) => m.platform === "peatix" && dueIds.has(m.officialEventId) && peatixCategoryOf(due.find((e) => e.canonicalEventId === m.officialEventId))
      );
      if (eligiblePeatix.length > 0) {
        try {
          const items = eligiblePeatix.map((m) => ({
            platformEventId: m.platformEventId,
            account: raw.find((r) => r.platform === "peatix" && String(r.platformEventId) === String(m.platformEventId))?.account
          })).filter((i) => i.account);
          const rows = await collectForPeatixEvents(items);
          for (const row of rows) {
            if (!row.amount) {
              row.amount = raw.find((r) => r.platform === "peatix" && String(r.platformEventId) === String(row.platformEventId) && r.ticketName === row.ticketName && r.amount)?.amount || "";
            }
            row.canonicalEventId = eligiblePeatix.find((m) => String(m.platformEventId) === String(row.platformEventId))?.officialEventId;
            freshPeatixIds.add(String(row.platformEventId));
            fresh.push(row);
          }
        } catch (err) {
          notes.push(`Peatixの最新化に失敗(直近の取得データで続行): ${err.message}`);
        }
      }
      overlay = raw.filter((r) => {
        if (r.platform === "peatix" && freshPeatixIds.has(String(r.platformEventId))) return false;
        if (wpFresh && r.platform === "wpBookings" && dueIds.has(r.canonicalEventId)) return false;
        if (r.platform === "kokuchpro" && freshPlatformEventIds.has(r.platformEventId)) return false;
        return true;
      }).concat(fresh);
      notes.forEach((n) => console.warn(n));
    }

    // 2. 入れる内容を組み立てる(台帳にある予約は除く)
    const { entries } = await buildEntries({ raw: overlay, official, ledger, sources: SOURCES, eventFilter: (e) => dueIds.has(e.canonicalEventId) });
    console.log(`未入力の予約: ${entries.length}件`);

    // 3. whitekeyにログインして、パーティーを探して入力する
    wk = await openWhitekey();
    await openPartyList(wk.page);
    // パーティー一覧は日付ごとに読む(夜20時の枠は、翌日・翌々日のイベントも対象になる)。
    const partiesByDate = new Map();
    const registrantsByParty = new Map(); // パーティーごとの「すでにwhitekeyにある予約」(重複を入力しないための照合用)
    const entryDate = (entry) => ymd(eventStart(entry, now));
    let shownDate = null; // いま一覧に表示している日付
    const showList = async (date) => {
      if (shownDate !== date) {
        await showDate(wk.page, date);
        shownDate = date;
      }
    };
    const loadParties = async (date) => {
      if (!partiesByDate.has(date)) {
        await showList(date);
        partiesByDate.set(date, annotateParties(await readParties(wk.page)));
      }
      return partiesByDate.get(date);
    };
    const ledgerRows = [];
    let stopped = "";
    for (const entry of entries) {
      if (entered >= limit || stopped) break;
      const date = entryDate(entry);
      const { party, state } = matchParty(entry, await loadParties(date));
      if (!party) {
        console.log(`  - 入れられません(${state}): ${entry.originalName} ${entry.month}/${entry.day} ${entry.venue} ${entry.time}`);
        continue;
      }
      // すでにwhitekeyに入っている予約(スタッフの手入力・以前の自動入力)と同じ人は、入力しない。
      if (!registrantsByParty.has(party.partycode)) {
        await showList(date);
        registrantsByParty.set(party.partycode, await readRegistrants(wk.page, party.partycode));
        shownDate = null; // 読み取り後は、一覧が今日の日付に戻る
      }
      const existing = findDuplicate(entry, registrantsByParty.get(party.partycode));
      if (existing) {
        duplicates += 1;
        console.log(`  - すでにwhitekeyにあるため入力しません: ${entry.originalName} ${entry.month}/${entry.day} ${entry.venue} ${entry.time} (${existing.keiyu}/${existing.status})`);
        continue;
      }
      const summary = `${entry.originalName} → ${entry.people.map((p) => p.sei + p.mei).join("+")} / ${entry.venue} ${entry.time} / ${entry.fee}円 / ${entry.keiyu.label}`;
      if (!commit) {
        console.log(`  - 入れる予定: ${summary} (${party.partycode})`);
        continue;
      }
      const before = party;
      try {
        await showList(date);
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
        shownDate = null;
        partiesByDate.delete(date);
        const after = (await loadParties(date)).find((p) => p.partycode === party.partycode);
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
    if (!stopped) markDone();
    const ok = !stopped;
    await reportStatus(sheetId, { ok, rowCount: entered, message: stopped || notes.join(" / ") });
    console.log(`完了: 登録${entered}件 / すでにあるため入力しない${duplicates}件${stopped ? " / 停止: " + stopped : ""}`);
    if (stopped) process.exitCode = 1;
  } catch (err) {
    console.error("whitekey自動入力でエラー:", err.message);
    await reportStatus(sheetId, { ok: false, rowCount: entered, message: err.message });
    process.exitCode = 1;
  } finally {
    if (wk) await wk.close();
  }
}

// ダッシュボードの画面データのキャッシュを温めておく(失敗しても入力処理には影響させない)。
const warm = warmDashboardCache().catch((err) => console.warn("ダッシュボードのキャッシュ更新に失敗しました:", err.message));
main().finally(() => warm);
