import { withBrowser } from "../lib/browser.mjs";

// ジモティーには他媒体(Peatix/こくちーずPRO/つなげーと)のような「参加者一覧」
// ページが無い。投稿ページには「投稿者にメールで問い合わせ」とあるのみで、
// 参加希望者は個別にメッセージで問い合わせる仕組みになっている(2026年9月に
// 実アカウントで画面確認)。そのため、ここで集計する「予約」は正確には
// 「問い合わせをしてきた人」であり、他媒体の確定予約とは性質が異なる点に
// 注意(ユーザーへの確認により、普段の運用でも「メール管理」画面で
// 問い合わせ者を確認しているとのことなので、それに準拠する)。
//
// ログインはメールアドレス+パスワードのみ(Peatix/つなげーとと異なり、
// 2段階認証・メール確認は不要。実アカウントで確認済み)。

function accountsFromEnv() {
  const accounts = [];
  const email = process.env.JIMOTY_1_EMAIL;
  const password = process.env.JIMOTY_1_PASSWORD;
  if (email && password) {
    accounts.push({
      label: process.env.JIMOTY_1_ACCOUNT_LABEL || "ジモティ",
      email,
      password
    });
  }
  return accounts;
}

async function login(page, account) {
  await page.goto("https://jmty.jp/my/posts", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  if (!/\/users\/sign_in/.test(page.url())) return; // 既にログイン済み

  await page.goto("https://jmty.jp/users/sign_in", { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("例）email@jmty.jp").fill(account.email);
  await page.getByPlaceholder("●●●●●●●●").fill(account.password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.getByRole("button", { name: /ログイン/ }).click()
  ]);
  await page.waitForTimeout(1000);
}

// 「メール管理」(/web_mail/posts)を全ページたどり、問い合わせが1件以上ある
// 投稿のpostId一覧を集める。このページのリンクテキストにはタイトルの他に
// 問い合わせ内容のプレビュー文まで混入しており正確なタイトルが取れないため、
// タイトル自体は後でgetArticleInfoが記事ページから取得する。
async function listPostsWithInquiries(page) {
  const postIds = new Set();
  for (let pageNum = 1; pageNum <= 30; pageNum += 1) {
    const url = pageNum === 1 ? "https://jmty.jp/web_mail/posts" : `https://jmty.jp/web_mail/posts?page=${pageNum}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/web_mail/posts/"][href$="/threads"]')).map((a) => a.getAttribute("href"))
    );
    if (hrefs.length === 0) break;
    let added = 0;
    for (const href of hrefs) {
      const match = href.match(/\/web_mail\/posts\/([^/]+)\/threads/);
      if (!match) continue;
      if (!postIds.has(match[1])) {
        postIds.add(match[1]);
        added += 1;
      }
    }
    if (added === 0) break;
  }
  return Array.from(postIds);
}

// 1投稿分の問い合わせスレッド一覧から、問い合わせ者名を集める。
// 1ページ目を開いたタイミングで、下部にある実際の記事(公開ページ)への
// リンクも一緒に拾っておく(タイトル・開催日取得用)。
async function listInquirerNamesAndArticleHref(page, postId) {
  const names = [];
  let articleHref = null;
  for (let pageNum = 1; pageNum <= 10; pageNum += 1) {
    const url =
      pageNum === 1
        ? `https://jmty.jp/web_mail/posts/${postId}/threads`
        : `https://jmty.jp/web_mail/posts/${postId}/threads?page=${pageNum}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    if (pageNum === 1) {
      articleHref = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href*="/eve-"]')).find(
          (el) => !el.getAttribute("href").includes("/web_mail/")
        );
        return a ? a.getAttribute("href") : null;
      });
    }
    const rowNames = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="/web_mail/threads/"]')).map((a) => {
        const text = (a.textContent || "").replace(/\s+/g, " ").trim();
        // 「【問い合わせ】 スズキアヤカ メール数(2) 女性 東京都中野区 ...」の
        // ような並びから、カテゴリラベルと直後の名前部分だけを取り出す。
        const m = text.match(/(?:問い合わせ|コメント)】\s*([^\s]+(?:\s[^\s]+)?)\s*メール数/);
        return m ? m[1].trim() : null;
      });
    });
    const filtered = rowNames.filter(Boolean);
    if (filtered.length === 0) break;
    names.push(...filtered);
    if (filtered.length < 10) break; // 最終ページ
  }
  return { names, articleHref };
}

// 記事(公開ページ)から正式なタイトルと開催日を取得する。開催日はPeatix同様、
// rawEventNameに埋め込むことで公式スケジュールとの日付+会場照合を可能にする。
async function getArticleInfo(page, articleHref) {
  if (!articleHref) return { title: null, month: null, day: null };
  const articleUrl = articleHref.startsWith("http") ? articleHref : `https://jmty.jp${articleHref}`;
  await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  return page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const title = h1 ? h1.textContent.trim() : document.title.split("｜")[0].trim();
    const bodyText = document.body.innerText;
    const dateMatch = bodyText.match(/開催日\s*\n?\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
    return {
      title,
      month: dateMatch ? Number(dateMatch[2]) : null,
      day: dateMatch ? Number(dateMatch[3]) : null
    };
  });
}

async function scrapeAccount(account) {
  return withBrowser(`jimoty-${account.label}`, async (page) => {
    await login(page, account);

    const postIds = await listPostsWithInquiries(page);
    console.error(`[ジモティ診断] 問い合わせありの投稿数=${postIds.length}`);

    const reservations = [];
    // Peatixと同じくユーザー指示により当月分のみ対象とする
    // (ジモティは投稿がすぐには片付かず、古い開催日の投稿がずっと残るため、
    // 絞らないと過去分の「未マッピング」が延々と積み上がってしまう)。
    const now = new Date();
    const targetMonth = now.getMonth() + 1;

    for (const postId of postIds) {
      const { names, articleHref } = await listInquirerNamesAndArticleHref(page, postId);
      if (names.length === 0) continue;
      const info = await getArticleInfo(page, articleHref);
      if (info.month !== targetMonth) continue;
      const dateSuffix = info.month && info.day ? `｜${info.month}月${info.day}日` : "";
      const rawEventName = `${info.title || postId}${dateSuffix}`;
      for (const name of names) {
        reservations.push({ rawEventName, reservationName: name });
      }
    }
    return reservations;
  });
}

export async function collect() {
  const accounts = accountsFromEnv();
  const obtainedAt = new Date().toISOString();
  const rows = [];

  for (const account of accounts) {
    let reservations = [];
    try {
      reservations = await scrapeAccount(account);
    } catch (err) {
      console.error(`jimoty(${account.label}) の取得に失敗しました:`, err.message);
      continue;
    }
    for (const reservation of reservations) {
      rows.push({
        platform: "jimoty",
        account: account.label,
        rawEventName: reservation.rawEventName,
        reservationName: reservation.reservationName,
        obtainedAt
      });
    }
  }
  return rows;
}
