import { INACTIVE_STATUS } from "./whitekeyRules.mjs";
import { KEIYU_BY_PLATFORM, KEIYU_OTHER } from "./whitekeyPlan.mjs";
import { normKana } from "./whitekeyMatch.mjs";
import { ensureSession, openPartyList, showDate } from "./whitekeyClient.mjs";

// 予約側(こくちーず・公式サイト・Peatixなど)でキャンセルになった予約について、whitekeyの受付を「キャンセル」にする。
// 対象は、自動入力した予約(台帳 WhitekeyLedger)だけ。スタッフが手で入れた受付には触れない。
// 安全のための条件:
//   ・その予約(予約番号)の行が、全てキャンセル(取消・不参加を含む)になっている
//   ・同じイベントに、同じ名前の別の有効な予約が無い(キャンセルして申し直した人の受付を、消さない)
//   ・whitekeyのパーティーの受付(完了)から、台帳の姓・きっかけで「ちょうど1件」に決まる(0件・2件以上は飛ばして報告)
//   ・同伴者のいる予約(2名以上)は、自動ではキャンセルせず、報告だけする(手作業)
// 受付画面の「キャンセル」ボタン(btnCancel0)を押す(「取り消し」ではなく、お客様のキャンセルとして記録される)。

const eventDateOf = (ledgerRow, today) => {
  const [m, d] = String(ledgerRow.eventDate).split("/").map(Number);
  return new Date(today.getFullYear(), m - 1, d);
};

// キャンセルにすべき台帳の予約を探す。
export function findCancelCandidates({ raw, ledger, cancelledSet, now = new Date(), daysBack = 5 }) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rowsByKey = new Map();
  const activeNames = new Map(); // "イベントID|名前" -> 有効な予約番号の集合
  for (const r of raw) {
    if (!rowsByKey.has(r.bookingKey)) rowsByKey.set(r.bookingKey, []);
    rowsByKey.get(r.bookingKey).push(r);
    if (!INACTIVE_STATUS.test(String(r.bookingStatus || ""))) {
      const k = `${r.canonicalEventId}|${String(r.normalizedName || r.reservationName || "").trim()}`;
      if (!activeNames.has(k)) activeNames.set(k, new Set());
      activeNames.get(k).add(r.bookingKey);
    }
  }
  const out = [];
  const skipped = { rebooked: 0, group: 0 };
  for (const l of Object.values(ledger)) {
    if (!l.partycode || cancelledSet.has(l.bookingKey)) continue;
    const rows = rowsByKey.get(l.bookingKey) || [];
    if (rows.length === 0 || !rows.every((r) => INACTIVE_STATUS.test(String(r.bookingStatus || "")))) continue;
    const date = eventDateOf(l, today);
    if (date < new Date(today.getTime() - daysBack * 86400000)) continue;
    const eventId = rows[0].canonicalEventId;
    const nameKey = `${eventId}|${String(rows[0].normalizedName || rows[0].reservationName || "").trim()}`;
    if ([...(activeNames.get(nameKey) || [])].some((k) => k !== l.bookingKey)) { skipped.rebooked += 1; continue; }
    if (Number(l.people || 1) > 1) { out.push({ ledger: l, manual: true }); skipped.group += 1; continue; }
    out.push({ ledger: l, rows, platform: rows[0].platform, keiyu: (KEIYU_BY_PLATFORM[rows[0].platform] || KEIYU_OTHER).label });
  }
  return { candidates: out.sort((a, b) => eventDateOf(a.ledger, today) - eventDateOf(b.ledger, today)), skipped };
}

async function readRows(page, partycode) {
  await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator(`tr#trData_${partycode} a.detailOpen`).first().evaluate((el) => el.click())]);
  await page.waitForSelector("table", { timeout: 60000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a.orderChange")];
    const out = [];
    for (const tr of document.querySelectorAll("tr")) {
      const tds = [...tr.children].filter((c) => c.tagName === "TD");
      if (tds.length < 30) continue;
      const ni = tds.findIndex((c) => /(^|\s)(man|woman)(\s|$)/.test(c.className));
      if (ni < 0) continue;
      const text = (i) => (tds[i]?.textContent || "").replace(/\s+/g, " ").trim();
      const link = tds[ni - 1].querySelector("a.orderChange");
      out.push({ kana: text(ni), keiyu: text(ni + 12), status: text(ni + 13), changeIndex: link ? links.indexOf(link) : -1 });
    }
    return out;
  });
}

// 一覧画面(日付の入力欄がある画面)に戻る。詳細・変更画面なら「戻る」で、メニューの画面なら「パーティー受付状況一覧」で戻る。
async function leaveToList(page) {
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    for (let i = 0; i < 6; i += 1) {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      if (await page.locator('input[name="searchInputDate"]').count()) return;
      if (await ensureSession(page).catch(() => false)) continue; // ログイン画面になっていたら、ログインし直す
      // 「戻る」ボタンが出るのを待ってから押す(押した直後の画面の切り替わりを待つ。固定の待ちだと、取り消し・キャンセル直後に間に合わないことがある)
      const back = await page.waitForSelector("#back", { timeout: 15000 }).catch(() => null);
      if (back) {
        await page.locator("#back").first().evaluate((el) => el.click());
        await page.waitForSelector('input[name="searchInputDate"]', { timeout: 20000 }).catch(() => {});
      } else if (await page.locator('span[name="btnPartyJokyo"]').count()) {
        await openPartyList(page);
      } else {
        await page.waitForTimeout(3000);
      }
    }
  } finally {
    page.off("dialog", onDialog);
  }
}

// 候補を実行する(commit が false なら、対象を決めるだけ)。返り値: 1件ごとの結果の配列。
export async function executeCancels(page, candidates, { commit, limit = 15, log = console.log } = {}) {
  const results = [];
  let done = 0;
  for (const c of candidates) {
    const l = c.ledger;
    const label = `${l.eventDate} ${l.venue} ${l.time} ${l.name}`;
    if (c.manual) { results.push({ ledger: l, result: "手作業(同伴者あり)" }); log(`  - 手作業が必要です(同伴者あり): ${label} ${l.people}名`); continue; }
    if (done >= limit) break;
    try {
      await leaveToList(page); // 前の処理で画面が一覧に戻っていなくても、ここで一覧に戻す
      const date = (() => { const [m, d] = String(l.eventDate).split("/").map(Number); const now = new Date(); return `${now.getFullYear()}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`; })();
      await showDate(page, date);
      const rows = await readRows(page, l.partycode);
      const sei = normKana(l.sei);
      const same = rows.filter((r) => normKana(r.kana).startsWith(sei) && (r.keiyu === c.keiyu || !r.keiyu));
      const active = same.filter((r) => r.status === "完了" && r.keiyu === c.keiyu);
      if (active.length === 0) {
        const already = same.some((r) => r.status === "キャンセル" || r.status === "取消");
        results.push({ ledger: l, result: already ? "既にキャンセル済み" : "whitekeyに見つかりません" });
        log(`  - ${already ? "既にキャンセル済み" : "whitekeyに見つかりません"}: ${label}`);
        await leaveToList(page);
        continue;
      }
      if (active.length > 1) {
        results.push({ ledger: l, result: `対象が${active.length}件で決まりません` });
        log(`  - 対象が${active.length}件で決まらないため飛ばしました: ${label} ${active.map((a) => a.kana).join(" / ")}`);
        await leaveToList(page);
        continue;
      }
      const hit = active[0];
      if (!commit) { results.push({ ledger: l, result: "確認のみ", kana: hit.kana }); log(`  - キャンセル対象: ${label} → ${hit.kana}`); await leaveToList(page); continue; }
      const onDialog = (d) => d.accept().catch(() => {});
      page.on("dialog", onDialog);
      try {
        await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("a.orderChange").nth(hit.changeIndex).evaluate((el) => el.click())]);
        await page.waitForSelector("#btnCancel0", { timeout: 60000 });
        const shown = normKana(`${await page.inputValue("#kana_sei0")} ${await page.inputValue("#kana_mei0")}`);
        if (shown !== normKana(hit.kana)) throw new Error(`変更画面の氏名が一致しません(${shown})`);
        await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("#btnCancel0").evaluate((el) => el.click())]);
        await page.waitForTimeout(2500);
      } finally {
        page.off("dialog", onDialog);
      }
      await leaveToList(page);
      // 確認: 読み直して、キャンセルになったか
      await showDate(page, date);
      const after = (await readRows(page, l.partycode)).find((r) => normKana(r.kana) === normKana(hit.kana) && r.status !== "完了");
      await leaveToList(page);
      const ok = after && /キャンセル|取消/.test(after.status);
      results.push({ ledger: l, result: ok ? "キャンセル" : "確認できません", kana: hit.kana });
      log(`  - ${ok ? "キャンセルしました" : "キャンセルを確認できません"}: ${label} → ${hit.kana}`);
      done += 1;
    } catch (err) {
      results.push({ ledger: l, result: "失敗: " + err.message });
      log(`  ! 失敗: ${label}: ${err.message.split("\n")[0]}`);
      try { log(`    (画面: ${page.url()} / ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 160)})`); } catch {}
      await leaveToList(page).catch(() => {});
      break;
    }
  }
  return results;
}
