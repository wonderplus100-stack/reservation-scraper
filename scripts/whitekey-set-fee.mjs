import "dotenv/config";
import { normKana } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, showDate } from "../lib/whitekeyClient.mjs";

// whitekeyの受付1件の料金を変更する(ユーザーの指示のあった1件だけ)。受付画面の「料金(gaku0)」を書き換えて「更新」を押す。
// 対象は、パーティーの受付(完了)から「ちょうど1件」に決まる時だけ。実行は --commit を付けた時だけ(付けなければ、対象を表示するだけ)。
// 使い方: node scripts/whitekey-set-fee.mjs --date=2026/11/16 --party=JP2026110934316 --sei=アラミ --mei=ジュンヤ --keiyu=Peatix --fee=0 [--commit]
const arg = (n, d = "") => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const date = arg("date"), partycode = arg("party"), sei = arg("sei"), mei = arg("mei"), keiyu = arg("keiyu");
const fee = arg("fee");
const commit = process.argv.includes("--commit");
if (!date || !partycode || !sei || fee === "") throw new Error("--date --party --sei --fee を指定してください");

async function readRows(page) {
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
      out.push({ kana: text(ni), keiyu: text(ni + 12), status: text(ni + 13), fee: text(ni + 6).replace(/[^0-9]/g, ""), changeIndex: link ? links.indexOf(link) : -1 });
    }
    return out;
  });
}

const wk = await openWhitekey();
const page = wk.page;
const onDialog = (d) => { console.log("  (確認ダイアログ:", d.message(), ")"); d.accept().catch(() => {}); };
try {
  await openPartyList(page);
  await showDate(page, date);
  const rows = await readRows(page);
  const hits = rows.filter((r) => r.status === "完了" && normKana(r.kana).startsWith(normKana(sei)) && (!mei || normKana(r.kana).includes(normKana(mei))) && (!keiyu || r.keiyu === keiyu));
  if (hits.length !== 1) throw new Error(`対象が${hits.length}件です: ${hits.map((h) => h.kana).join(" / ")}`);
  const hit = hits[0];
  console.log(`対象: ${hit.kana} (${hit.keiyu}) 料金 ${hit.fee}円 → ${fee}円`);
  if (!commit) {
    console.log("(確認のみ。変更するには --commit)");
  } else {
    page.on("dialog", onDialog);
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("a.orderChange").nth(hit.changeIndex).evaluate((el) => el.click())]);
    await page.waitForSelector("#gaku0", { timeout: 60000 });
    const shown = normKana(`${await page.inputValue("#kana_sei0")} ${await page.inputValue("#kana_mei0")}`);
    if (shown !== normKana(hit.kana)) throw new Error(`変更画面の氏名が一致しません(${shown})`);
    await page.fill("#gaku0", fee);
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("#btnChange0").evaluate((el) => el.click())]);
    await page.waitForTimeout(2500);
    page.off("dialog", onDialog);
    // 一覧に戻って、料金が変わったか読み直す
    for (let i = 0; i < 3; i += 1) {
      if (await page.locator('input[name="searchInputDate"]').count()) break;
      page.once("dialog", (d) => d.accept().catch(() => {}));
      if (await page.locator("#back").count()) await page.locator("#back").first().evaluate((el) => el.click());
      await page.waitForTimeout(2500);
    }
    await showDate(page, date);
    const after = (await readRows(page)).find((r) => normKana(r.kana) === normKana(hit.kana) && r.status === "完了");
    console.log(`確認: ${after ? after.kana + " 料金 " + after.fee + "円 状態 " + after.status : "見つかりません"}`);
  }
} finally {
  await wk.close();
}
