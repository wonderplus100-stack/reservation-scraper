import "dotenv/config";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects, readWhitekeyLedger } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { normKana } from "../lib/whitekeyMatch.mjs";
import { openPartyList, openWhitekey, readParties, readRegistrants, showDate } from "../lib/whitekeyClient.mjs";

// 入力後の確認(読み取り専用): 台帳に記録された予約が、whitekeyのパーティーに入っているかを、人ごとに照合する。
// 使い方: node scripts/whitekey-verify.mjs --date=2026/11/17
const date = (process.argv.find((a) => a.startsWith("--date=")) || "--date=").slice(7);
const ledger = await readWhitekeyLedger(process.env.SHEET_ID);
const rows = Object.values(ledger).filter((l) => l.partycode);
const byParty = new Map();
for (const l of rows) (byParty.get(l.partycode) || byParty.set(l.partycode, []).get(l.partycode)).push(l);
const [raw, official] = await Promise.all([readSheetAsObjects(process.env.SHEET_ID, RAW_DATA_SHEET), readSheetAsObjects(process.env.SHEET_ID, OFFICIAL_EVENTS_SHEET)]);
const wk = await openWhitekey();
let ok = 0, ng = 0, extra = 0;
try {
  await openPartyList(wk.page);
  await showDate(wk.page, date);
  const parties = await readParties(wk.page);
  for (const [code, list] of byParty) {
    const p = parties.find((x) => x.partycode === code);
    if (!p) continue;
    await showDate(wk.page, date);
    const regs = (await readRegistrants(wk.page, code)).filter((r) => r.status === "完了");
    const used = new Set();
    const missing = [];
    for (const l of list) {
      for (let i = 0; i < Number(l.people || 1); i += 1) {
        const hit = regs.find((r) => !used.has(r) && normKana(r.kana).startsWith(normKana(l.sei)));
        if (hit) { used.add(hit); ok += 1; } else { ng += 1; missing.push(`${l.name}(${l.sei})`); }
      }
    }
    const rest = regs.filter((r) => !used.has(r));
    extra += rest.length;
    console.log(`${code} ${p.time} ${p.hall.slice(0, 8)} | 台帳${list.length}件/${list.reduce((n, l) => n + Number(l.people || 1), 0)}名 | whitekey完了${regs.length}名(男${p.doneMen}/女${p.doneWomen}) | 照合OK${used.size} 見つからない${missing.length}${missing.length ? " " + missing.join("、") : ""} 台帳外${rest.length}`);
  }
} finally {
  await wk.close();
}
console.log(`合計: 照合OK ${ok} / 見つからない ${ng} / 台帳外の受付 ${extra}`);
