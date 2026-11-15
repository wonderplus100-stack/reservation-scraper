import "dotenv/config";
import fs from "node:fs";
import { OFFICIAL_EVENTS_SHEET, RAW_DATA_SHEET, readSheetAsObjects } from "../lib/sheetsClient.mjs";
import { buildEntries } from "../lib/whitekeyPlan.mjs";
import { normKana } from "../lib/whitekeyMatch.mjs";

// 氏名の読みの精度を測る(whitekeyには触れない)。
// 正解 = スタッフが whitekey に入れたカナ(data/whitekey-reconcile-raw.json に保存済みの、過去1週間の受付)。
// 予約から作った読み(現在のプログラム)と、同じイベント・同じ性別の受付を、読みが近い順に1対1で対応づけ、
// 「姓名とも一致 / 姓だけ一致 / 姓も違う」に分ける。対応づけできない予約は数えない(whitekeyに無い人)。
// 使い方: node scripts/name-accuracy.mjs [--show=wrong]
const show = (process.argv.find((a) => a.startsWith("--show=")) || "--show=").slice(7);
const raw = JSON.parse(fs.readFileSync("data/whitekey-reconcile-raw.json", "utf8"));
const [rr, oo] = await Promise.all([readSheetAsObjects(process.env.SHEET_ID, RAW_DATA_SHEET), readSheetAsObjects(process.env.SHEET_ID, OFFICIAL_EVENTS_SHEET)]);
const ids = new Set(raw.events.map((e) => e.id));
const { entries } = await buildEntries({ raw: rr, official: oo, ledger: {}, sources: ["kokuchpro", "wpBookings", "peatix"], eventFilter: (e) => ids.has(e.canonicalEventId) });

function dist(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
const seiOf = (k) => normKana(String(k).split(/[\s　]/)[0]);
const meiOf = (k) => normKana(String(k).split(/[\s　]/).slice(1).join(""));
const res = { total: 0, exact: 0, seiOnly: 0, wrong: 0 };
const bySource = {};
const wrongList = [];
for (const ev of raw.events) {
  const mine = entries.filter((e) => e.canonicalEventId === ev.id && e.people.length >= 1);
  const regs = (raw.registrantsByParty[ev.party] || []).filter((r) => r.status === "完了");
  const pairs = [];
  mine.forEach((m, mi) => regs.forEach((r, ri) => {
    if (r.gender !== (m.sexkbn === "2" ? "女" : "男")) return;
    const ours = normKana(m.people[0].sei + (/^[0-9]+$/.test(m.people[0].mei) ? "" : m.people[0].mei));
    const theirs = normKana(r.kana);
    const d = dist(ours, theirs);
    if (d <= Math.max(3, Math.ceil(theirs.length * 0.6))) pairs.push({ mi, ri, d });
  }));
  pairs.sort((a, b) => a.d - b.d);
  const usedM = new Set(), usedR = new Set();
  for (const p of pairs) {
    if (usedM.has(p.mi) || usedR.has(p.ri)) continue;
    usedM.add(p.mi); usedR.add(p.ri);
    const m = mine[p.mi], r = regs[p.ri];
    const numbered = /^[0-9]+$/.test(m.people[0].mei);
    const sei = normKana(m.people[0].sei);
    const exact = normKana(m.people[0].sei + (numbered ? "" : m.people[0].mei)) === normKana(r.kana);
    const seiOk = seiOf(r.kana) === sei;
    res.total += 1;
    (bySource[m.platform] ||= { total: 0, exact: 0, seiOnly: 0, wrong: 0 }).total += 1;
    const kind = exact ? "exact" : seiOk ? "seiOnly" : "wrong";
    res[kind] += 1; bySource[m.platform][kind] += 1;
    if (kind !== "exact") wrongList.push({ kind, platform: m.platform, name: m.originalName, ours: `${m.people[0].sei} ${m.people[0].mei}`, theirs: r.kana });
  }
}
console.log(JSON.stringify(res), "\n", JSON.stringify(bySource));
console.log(`完全一致率 ${(res.exact / res.total * 100).toFixed(1)}% / 姓だけ一致 ${(res.seiOnly / res.total * 100).toFixed(1)}% / 姓も違う ${(res.wrong / res.total * 100).toFixed(1)}%`);
fs.writeFileSync("data/name-accuracy.json", JSON.stringify(wrongList, null, 1));
if (show) for (const w of wrongList.filter((x) => x.kind === show)) console.log(`${w.platform[0]} ${w.name} | ours ${w.ours} | staff ${w.theirs}`);
