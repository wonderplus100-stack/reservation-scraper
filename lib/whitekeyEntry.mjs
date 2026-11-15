// whitekey「パーティー受付登録」画面への入力部品。
// 項目名・動作は、実際の画面(partyRegist.php)のHTMLから読み取ったもの:
//  - 代表者は枝番0、同伴者は1〜7(tel0/kana_sei0/kana_mei0/sexkbn0/byyyy0/bmm0/bdd0/age0/gaku0 …)
//  - 「パーティーを知ったきっかけ」は select[name=keiyuk0](代表者のみ)
//  - 「登録」ボタン(.btnRegist)は、確認事項3つ(#cancel #irregular #teltuti)と、
//    待ち(#wait)・完了(#comp)のどちらか1つにチェックが入るまで押せない
//  - 登録・戻る(#back)は確認ダイアログが出る。戻る(#back)は「対応中の受付を取り消す」操作で、
//    受付画面を開いたまま閉じると対応中の状態が残るため、登録しない場合は必ず #back で抜ける。
//
// 本番システムへの書き込み(登録)は commit: true のときだけ行う。既定は入力して止める。
const BIRTH = { year: "2000", month: "1", day: "1", age: "25" };
const TEL = "00000000000";
const MAX_PEOPLE = 8; // 代表者1 + 同伴者7

// 一覧画面(menu.php)で、パーティーの「受付」ボタンを押して受付登録画面を開く。
export async function openRegistration(page, partycode) {
  const row = page.locator(`tr#trData_${partycode}`).first();
  if (!(await row.count())) throw new Error(`一覧にパーティーが見つかりません: ${partycode}`);
  await Promise.all([page.waitForSelector("#kana_sei0", { timeout: 60000 }), // 画面上部の固定ヘッダーが重なって通常のクリックが届かないため(2026-11-15 実際に発生)、スクリプトでクリックする。
    row.locator("button.btn_rece").evaluate((el) => el.click())]);
}

async function fillPerson(page, index, person, { sexkbn, fee }) {
  await page.fill(`#tel${index}`, TEL);
  await page.fill(`#kana_sei${index}`, person.sei);
  await page.fill(`#kana_mei${index}`, person.mei);
  await page.check(`input[name="sexkbn${index}"][value="${sexkbn}"]`);
  await page.fill(`#byyyy${index}`, BIRTH.year);
  await page.fill(`#bmm${index}`, BIRTH.month);
  await page.fill(`#bdd${index}`, BIRTH.day);
  await page.fill(`#age${index}`, BIRTH.age);
  await page.fill(`#gaku${index}`, String(fee));
}

// 入力内容(entry は scripts/whitekey-plan.mjs が作る1件)を受付登録画面に入力する。
export async function fillRegistration(page, entry) {
  if (entry.people.length > MAX_PEOPLE) throw new Error(`人数が多すぎます(${entry.people.length}人。最大${MAX_PEOPLE}人)`);
  for (const [index, person] of entry.people.entries()) {
    await fillPerson(page, index, person, { sexkbn: entry.sexkbn, fee: entry.fee });
  }
  await page.selectOption('select[name="keiyuk0"]', entry.keiyu.value);
  // 確認事項(ユーザー了承済み: 自動で入れる)と、予約状況「完了」。担当者は既定(ログインしたアカウント)のまま。
  for (const id of ["#cancel", "#irregular", "#teltuti", "#comp"]) await page.check(id);
}

// 入力内容を画面から読み戻す(登録前の確認・記録用)。
export async function readBackRegistration(page, peopleCount) {
  return page.evaluate((count) => {
    const val = (sel) => document.querySelector(sel)?.value ?? "";
    const people = [];
    for (let i = 0; i < count; i += 1) {
      people.push({
        sei: val(`#kana_sei${i}`), mei: val(`#kana_mei${i}`), tel: val(`#tel${i}`),
        sex: document.querySelector(`input[name="sexkbn${i}"]:checked`)?.value || "",
        birth: `${val(`#byyyy${i}`)}/${val(`#bmm${i}`)}/${val(`#bdd${i}`)}`, age: val(`#age${i}`), fee: val(`#gaku${i}`)
      });
    }
    return {
      people,
      keiyu: document.querySelector('select[name="keiyuk0"]')?.selectedOptions[0]?.textContent.trim() || "",
      userid: document.querySelector('select[name="userid"]')?.selectedOptions[0]?.textContent.trim() || "",
      checks: ["#cancel", "#irregular", "#teltuti", "#comp", "#wait"].map((s) => `${s}:${document.querySelector(s)?.checked ? 1 : 0}`).join(" "),
      registerEnabled: !document.querySelector(".btnRegist")?.disabled
    };
  }, peopleCount);
}

// 登録せずに受付登録画面から抜ける(対応中の状態を解除する)。確認ダイアログは承諾する。
export async function leaveWithoutRegistering(page) {
  const onDialog = (dialog) => dialog.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await Promise.all([page.waitForSelector('span[name="btnPartyJokyo"], tr.trData', { timeout: 60000 }), page.locator("#back").first().evaluate((el) => el.click())]);
  } finally {
    page.off("dialog", onDialog);
  }
}

// 登録の直後に、一覧画面(日付の入力欄がある画面)に戻る。登録直後は、画面がまだ切り替わっていない・登録画面のままのことがあるため、
// 入力欄か「戻る」ボタンが出るのを待ち、登録画面なら「戻る」で抜ける。数回やり直しても戻れなければエラーにする
// (2026-11-15 本番入力で、登録直後に待ち時間が足りず、一覧に戻れずに止まったことが2回あった)。
export async function returnToList(page) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (await page.locator('input[name="searchInputDate"]').count()) return;
    try {
      await page.waitForSelector('input[name="searchInputDate"], #back', { timeout: 30000 });
      if (await page.locator('input[name="searchInputDate"]').count()) return;
      await leaveWithoutRegistering(page);
    } catch {
      // 次の試行へ
    }
    await page.waitForTimeout(3000);
  }
  if (!(await page.locator('input[name="searchInputDate"]').count())) throw new Error("一覧画面に戻れませんでした");
}

// 登録ボタンを押す。確認ダイアログ(登録確認・0円確認)は承諾する。commit: true のときだけ実行。
export async function submitRegistration(page, { commit }) {
  if (!commit) throw new Error("commit: true でないため登録しません");
  const dialogs = [];
  const onDialog = (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept().catch(() => {});
  };
  page.on("dialog", onDialog);
  try {
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator(".btnRegist").first().evaluate((el) => el.click())]);
    await page.waitForTimeout(2000);
  } finally {
    page.off("dialog", onDialog);
  }
  return { dialogs, url: page.url(), title: await page.title() };
}
