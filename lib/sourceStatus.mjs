// 媒体(アカウント)ごとの取得結果を、実行中に集めておくための入れ物。
// 各スクレイパーが取得の成功/失敗を報告し、run.mjsが最後にSourceStatusシートへ
// まとめて書き出す。ダッシュボードはこのシートを読み、「どの媒体が最後にいつ
// 取得できたか」「取得に失敗していないか」を画面に出す。
//
// 以前は失敗がコンソールのログにしか残らず、Peatixのセッション切れやイベマドの
// 403が何日続いていても、ダッシュボード上はデータが無いだけに見えていた。
const reports = new Map();

export function reportSource(platform, account, { ok, message = "" }) {
  reports.set(`${platform}|||${account}`, { platform, account, ok, message: String(message).slice(0, 300) });
}

export function getSourceReports() {
  return Array.from(reports.values());
}

// ログイン切れ等、人の操作が必要な失敗かどうかの判定(画面の案内文用)。
export function needsHumanAction(message) {
  return /セッション|ログイン|再ログイン|認証/.test(String(message));
}
