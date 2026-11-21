import "dotenv/config";
import fs from "node:fs";
import { normKana } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, showDate } from "../lib/whitekeyClient.mjs";

// whitekeyの受付を「取り消し」する(ユーザーが権限を付与 2026-11-18)。取り違えて入力した受付・二重に入力した受付を取り消す時に使う。
// 取消の対象は、計画ファイル(JSON)に書いた受付だけ。受付画面の「取り消し」ボタン(btnTorikeshi0)を押す。
// 安全のため: 計画の1件ごとに、パーティーの受付(完了)から対象が「ちょうど1件」に決まる時だけ実行する(0件・2件以上は飛ばして報告)。
// 実行は --commit を付けた時だけ。付けなければ、対象に決まった受付を表示するだけ。
//   計画: [{ "date": "2026/11/18", "partycode": "JP…", "sei": "ハラダ", "mei": "ダイチ"(任意), "keiyu": "こくちーず"(任意), "exactSei": true(姓の完全一致。任意),
//           "requires": { "date": "…", "partycode": "JP…", "sei": "…", "mei": "…"(任意), "exactSei": true(任意) }(任意), "note": "理由" }]
//   requires: 取り消す前に、「残す側の受付」が(完了で)ある時だけ取り消す。取り消した結果、その人の受付が1件も無くなる事故を防ぐ。
//   使い方: node scripts/whitekey-cancel.mjs --plan=data/cancel-plan.json [--commit]
const planPath = (process.argv.find((a) => a.startsWith("--plan=")) || "").slice(7);
if (!planPath) throw new Error("--plan=計画ファイル を指定してください");
const commit = process.argv.includes("--commit");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));

// パーティーの「詳細リスト表示」から、受付の行(姓名・性別・きっかけ・予約状況・変更リンクの番号)を読む。
async function readRows(page, partycode) {
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.locator(`tr#trData_${partycode} a.detailOpen`).first().evaluate((el) => el.click())
  ]);
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
      out.push({ kana: text(ni), gender: /woman/.test(tds[ni].className) ? "女" : "男", keiyu: text(ni + 12), status: text(ni + 13), fee: text(ni + 6), changeIndex: link ? links.indexOf(link) : -1 });
    }
    return out;
  });
}

async function backToList(page) {
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    if (await page.locator("#back").count()) {
      await Promise.all([page.waitForSelector('tr.trData, input[name="searchInputDate"]', { timeout: 60000 }), page.locator("#back").first().evaluate((el) => el.click())]);
    }
  } finally {
    page.off("dialog", onDialog);
  }
}

// 受付の行の姓名が、条件(姓の前方一致/完全一致・名の包含)に合うか
function matches(r, c) {
  const k = normKana(String(r.kana));
  const seiOfRow = normKana(String(r.kana).split(/[\s　]/)[0]);
  const sei = normKana(c.sei);
  if (c.exactSei ? seiOfRow !== sei : !k.startsWith(sei)) return false;
  if (c.mei && !k.includes(normKana(c.mei))) return false;
  if (c.keiyu && r.keiyu !== c.keiyu) return false;
  return true;
}

const wk = await openWhitekey();
const results = [];
try {
  await openPartyList(wk.page);
  for (const item of plan) {
    await showDate(wk.page, item.date);
    const rows = await readRows(wk.page, item.partycode);
    const sei = normKana(item.sei);
    const mei = item.mei ? normKana(item.mei) : "";
    const hits = rows.filter((r) => r.status === "完了" && matches(r, item));
    const label = `${item.date} ${item.partycode} ${item.sei}${item.mei ? " " + item.mei : ""}`;
    if (hits.length !== 1) {
      console.log(`  - 飛ばしました(対象が${hits.length}件): ${label} ${hits.map((h) => h.kana).join(" / ")}`);
      results.push({ ...item, result: `飛ばし(対象${hits.length}件)` });
      await backToList(wk.page);
      continue;
    }
    const hit = hits[0];
    // 「残す側の受付」があるかを確かめる(同じパーティーなら、読み取り済みの行から。別のパーティーなら、読み直す)
    if (item.requires) {
      let otherRows = rows;
      if (item.requires.partycode !== item.partycode || item.requires.date !== item.date) {
        await backToList(wk.page);
        await showDate(wk.page, item.requires.date);
        otherRows = await readRows(wk.page, item.requires.partycode);
        await backToList(wk.page);
        await showDate(wk.page, item.date);
        await readRows(wk.page, item.partycode); // 取り消す側の画面に戻る(変更リンクの番号を合わせる)
      }
      const keep = otherRows.filter((r) => r.status === "完了" && r !== hit && matches(r, item.requires));
      if (keep.length === 0) {
        console.log(`  - 飛ばしました(残す側の受付が見つかりません): ${label} → ${hit.kana}`);
        results.push({ ...item, result: "飛ばし(残す側なし)" });
        await backToList(wk.page);
        continue;
      }
      console.log(`    残す側: ${keep.map((k) => k.kana + "(" + k.keiyu + ")").join(" / ")}`);
    }
    if (!commit) {
      console.log(`  - 対象: ${label} → ${hit.kana} ${hit.gender} ${hit.fee}円 ${hit.keiyu} (${item.note || ""})`);
      results.push({ ...item, result: "確認のみ" });
      await backToList(wk.page);
      continue;
    }
    // 受付の「変更」を開き、姓名が一致することを確かめてから「取り消し」を押す
    const onDialog = (d) => d.accept().catch(() => {});
    wk.page.on("dialog", onDialog);
    try {
      await Promise.all([wk.page.waitForLoadState("domcontentloaded"), wk.page.locator("a.orderChange").nth(hit.changeIndex).evaluate((el) => el.click())]);
      await wk.page.waitForSelector("#btnTorikeshi0", { timeout: 60000 });
      // 受付画面には、同じ申込の代表者(0)と同伴者(1〜7)が並ぶ。氏名が一致する人の「取り消し」を押す(同伴者の行を開いても、その人を探す)。
      let target = -1;
      let shown = "";
      for (let i = 0; i < 8; i += 1) {
        if (!(await wk.page.locator(`#kana_sei${i}`).count())) break;
        const name = normKana(`${await wk.page.inputValue(`#kana_sei${i}`)} ${await wk.page.inputValue(`#kana_mei${i}`)}`);
        if (i === 0) shown = name;
        if (name === normKana(hit.kana)) { target = i; break; }
      }
      if (target < 0) throw new Error(`変更画面に対象の氏名がありません(先頭: ${shown} / 対象: ${normKana(hit.kana)})`);
      await Promise.all([wk.page.waitForLoadState("domcontentloaded"), wk.page.locator(`#btnTorikeshi${target}`).evaluate((el) => el.click())]);
      await wk.page.waitForTimeout(2500);
      console.log(`  - 取り消しました: ${label} → ${hit.kana} (${item.note || ""})`);
      results.push({ ...item, kana: hit.kana, result: "取消" });
    } catch (err) {
      console.error(`  ! 失敗: ${label}: ${err.message}`);
      results.push({ ...item, result: "失敗: " + err.message });
      wk.page.off("dialog", onDialog);
      await backToList(wk.page).catch(() => {});
      break; // 失敗したら、以降は止める
    }
    wk.page.off("dialog", onDialog);
    // 一覧に戻る(取り消し後の画面から)
    for (let i = 0; i < 3; i += 1) {
      if (await wk.page.locator('input[name="searchInputDate"]').count()) break;
      await backToList(wk.page).catch(() => {});
      await wk.page.waitForTimeout(1500);
    }
  }
  if (commit) {
    // 取り消しの確認: 取り消した受付が「取消」になっているか読み直す
    for (const r of results.filter((x) => x.result === "取消")) {
      await showDate(wk.page, r.date);
      const rows = await readRows(wk.page, r.partycode);
      const row = rows.find((x) => normKana(x.kana) === normKana(r.kana) && x.status !== "完了") || rows.find((x) => normKana(x.kana) === normKana(r.kana));
      r.after = row ? row.status : "見つからない";
      console.log(`    確認: ${r.date} ${r.kana} → ${r.after}`);
      await backToList(wk.page).catch(() => {});
    }
  }
} finally {
  await wk.close();
}
fs.writeFileSync(planPath.replace(/\.json$/, "") + (commit ? "-result.json" : "-dryrun.json"), JSON.stringify(results, null, 1));
console.log(`完了: 取消 ${results.filter((r) => r.result === "取消").length}件 / 飛ばし・失敗 ${results.filter((r) => /飛ばし|失敗/.test(r.result)).length}件 / 確認のみ ${results.filter((r) => r.result === "確認のみ").length}件`);
