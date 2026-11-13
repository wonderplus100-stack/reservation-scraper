import { readSheetValues } from "./sheetsClient.mjs";

// 公開ダッシュボードの画面データは、組み立てに十数秒かかるため、Apps Script側で5分間キャッシュしている。
// キャッシュが切れた直後に開いた人が長く待たないよう、専用PCの5分おきの実行のついでに先に呼んで温めておく。
// 失敗しても本処理には影響させない(呼び出し側で握りつぶす)。
// 必要な設定: .env の DASHBOARD_API_URL(Apps Script の /exec URL)。共有キーはスプレッドシートの Config シートから読む。
export async function warmDashboardCache() {
  const api = process.env.DASHBOARD_API_URL;
  if (!api || !process.env.SHEET_ID) return;
  const rows = await readSheetValues(process.env.SHEET_ID, "Config!A1:B10");
  const key = (rows.find((r) => r[0] === "dashboardKey") || [])[1];
  if (!key) return;
  await fetch(`${api}?api=fetchDashboardData&args=%5B%5D&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(60000) });
}
