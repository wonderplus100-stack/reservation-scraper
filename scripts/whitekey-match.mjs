import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openPartyList, openWhitekey, readParties, showDate } from "../lib/whitekeyClient.mjs";
import { annotateParties, matchParty, startTime } from "../lib/whitekeyMatch.mjs";

// 入力予定(data/whitekey-plan.json)の各予約を、whitekey側のどのパーティーに入れるかを突き合わせる。
// 日付 + 都市 + 開始時刻 で探す。whitekeyの一覧画面を読むだけで、何も変更しない
// (「受付」ボタンは押さない)。結果は data/whitekey-match.json と画面の要約に出す。
//
// 使い方: node scripts/whitekey-match.mjs   (先に node scripts/whitekey-plan.mjs で一覧を作る)
function entryDate(entry, today) {
  let date = new Date(today.getFullYear(), Number(entry.month) - 1, Number(entry.day));
  if (date < today) date = new Date(today.getFullYear() + 1, Number(entry.month) - 1, Number(entry.day));
  return date;
}

const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

async function main() {
  const planPath = path.resolve("data", "whitekey-plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dates = [...new Set(plan.map((e) => ymd(entryDate(e, today))))].sort();
  const wk = await openWhitekey();
  const partiesByDate = new Map();
  try {
    await openPartyList(wk.page);
    for (const date of dates) {
      await showDate(wk.page, date);
      const parties = annotateParties(await readParties(wk.page));
      partiesByDate.set(date, parties);
    }
  } finally {
    await wk.close();
  }

  const results = plan.map((entry) => {
    const date = ymd(entryDate(entry, today));
    const { party, state, candidates } = matchParty(entry, partiesByDate.get(date) || []);
    return {
      bookingKey: entry.bookingKey,
      date,
      venue: entry.venue,
      time: entry.time,
      eventName: entry.eventName,
      partycode: party ? party.partycode : "",
      matchState: state,
      candidates: candidates.map((c) => `${c.hall} ${c.time} ${c.partycode}`)
    };
  });
  fs.writeFileSync(path.resolve("data", "whitekey-match.json"), JSON.stringify(results, null, 1));

  const byState = {};
  results.forEach((r) => { byState[r.matchState] = (byState[r.matchState] || 0) + 1; });
  console.log(`突き合わせ結果(${results.length}件): ${JSON.stringify(byState)}`);
  const missing = new Map();
  for (const r of results.filter((x) => x.matchState !== "一致")) {
    const key = `${r.date} ${r.venue} ${r.time} [${r.matchState}]`;
    missing.set(key, (missing.get(key) || 0) + 1);
  }
  console.log("一致しなかったパーティー(日付 都市 時刻 [理由]: 予約件数):");
  for (const [key, count] of [...missing.entries()].sort()) console.log(`  ${key}: ${count}件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
