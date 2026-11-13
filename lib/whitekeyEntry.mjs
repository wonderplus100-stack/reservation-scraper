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
  await Promise.all([page.waitForSelector("#kana_sei0", { timeout: 60000 }), row.locator("button.btn_rece").click()]);
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
  page.once("dialog", (dialog) => dialog.accept());
  await Promise.all([page.waitForSelector('span[name="btnPartyJokyo"], tr.trData', { timeout: 60000 }), page.click("#back")]);
}

// 登録ボタンを押す。確認ダイアログ(登録確認・0円確認)は承諾する。commit: true のときだけ実行。
export async function submitRegistration(page, { commit }) {
  if (!commit) throw new Error("commit: true でないため登録しません");
  const dialogs = [];
  const onDialog = (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  };
  page.on("dialog", onDialog);
  try {
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.click(".btnRegist")]);
    await page.waitForTimeout(2000);
  } finally {
    page.off("dialog", onDialog);
  }
  return { dialogs, url: page.url(), title: await page.title() };
}
