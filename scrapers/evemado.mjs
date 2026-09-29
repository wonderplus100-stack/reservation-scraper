// イベマド(evemado.jp、Wonder+自社の予約ポータルサイト)の予約データを取得する。
//
// 管理画面(wp-admin)にログインして画面を操作する必要は無い。実アカウントで
// 確認したところ、予約(カスタム投稿タイプ evemado_reservation)は
// WordPress標準のREST APIでログイン不要のまま一覧取得できる
// (https://evemado.jp/wp-json/wp/v2/evemado_reservation)。
//
// タイトルは「予約者名 / イベント名（会場・M月D日）」という規約になっており
// (実アカウントで確認済み)、他媒体と同じくrawEventNameに会場+日付を含む形で
// そのままmatchOfficialEventに渡せる。
//
// 実データには、サイト構築時に投入されたと見られるダミー予約(ランダムな
// 英字文字列の予約者名+「Wonder+」を含まない汎用的なイベント名で、末尾に
// 「（会場・M月D日）」の表記が無い)が87件中63件混入していることを確認した。
// 末尾の「（会場・M月D日）」表記を必須とすることで、これらを自然に除外する。
const REST_ENDPOINT = "https://evemado.jp/wp-json/wp/v2/evemado_reservation";
const TITLE_PATTERN = /^(.+?) \/ (.+(?:[（(][^・）)]+・\d{1,2}月\d{1,2}日[）)]))$/;

async function fetchAllReservations() {
  const perPage = 100;
  const all = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(`${REST_ENDPOINT}?per_page=${perPage}&page=${page}&_fields=id,title`);
    if (!res.ok) {
      if (page > 1) break; // ページ範囲外(rest_post_invalid_page_number)
      throw new Error(`evemado REST APIエラー: ${res.status} ${res.statusText}`);
    }
    const rows = await res.json();
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < perPage) break;
  }
  return all;
}

export async function collect() {
  const obtainedAt = new Date().toISOString();
  const posts = await fetchAllReservations();

  const rows = [];
  for (const post of posts) {
    const title = String(post.title?.rendered || "");
    const match = title.match(TITLE_PATTERN);
    if (!match) continue; // ダミーデータ等、規約に合わないものはスキップ
    const [, reservationName, rawEventName] = match;
    rows.push({
      platform: "evemado",
      account: "evemado.jp",
      rawEventName,
      reservationName: reservationName.trim(),
      obtainedAt
    });
  }
  return rows;
}
