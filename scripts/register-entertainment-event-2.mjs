import "dotenv/config";
import { appendEventMasterRows } from "../lib/sheetsClient.mjs";

const sheetId = process.env.SHEET_ID;

await appendEventMasterRows(sheetId, [
  {
    canonicalEventId: "official-9-17-銀座-20002200",
    canonicalEventName: "9/17 銀座 Wonder+Entertainment 20:00-22:00",
    platform: "peatix",
    account: "Wonder Plus",
    rawEventName:
      "✨100人異業種交流会✨ 『Wonder+ENTERTAINMENT』 エンタメ×ビジネスにつながる仲間をみつける! フリースタイル/名刺交換&LINE交換/フリードリンク/ブッフェ/ワンダープラス｜9月17日"
  }
]);

console.log("登録しました");
