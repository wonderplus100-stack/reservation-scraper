import fs from "node:fs";
import path from "node:path";

// Apps Scriptのダッシュボード(Index.html)から、誰でも開ける静的ページ(docs/index.html)を作る。
// 画面は GitHub Pages で配信し、データは Apps Script のJSON API(Code.js の doGet/doPost)から
// 取得する。google.script.run を使う既存の画面コードは変えず、同じ呼び出しを
// fetchに置き換える小さな互換層を先頭に差し込む。
//
// 使い方: node scripts/build-static-dashboard.mjs [Index.htmlのパス]
//   既定: dashboard/Index.html (無ければ ../wonder-plus-reservation-dashboard/Index.html)
//   環境変数 DASHBOARD_API_URL に Apps Script の /exec URL を指定する。
const candidates = [process.argv[2], "dashboard/Index.html", "../wonder-plus-reservation-dashboard/Index.html"].filter(Boolean);
const source = candidates.find((p) => fs.existsSync(p));
if (!source) throw new Error(`Index.html が見つかりません: ${candidates.join(", ")}`);
const apiUrl = process.env.DASHBOARD_API_URL;
if (!apiUrl) throw new Error("環境変数 DASHBOARD_API_URL (Apps Script の /exec URL) を指定してください");

let body = fs.readFileSync(source, "utf8");

// GASテンプレートの差し込み(<?= initialTab ?>)を、URLの ?tab= から決める記述に置き換える。
body = body.replace(
  '"<?= initialTab ?>"',
  '(["upcoming", "past", "unlinked"].includes(new URLSearchParams(location.search).get("tab")) ? new URLSearchParams(location.search).get("tab") : "upcoming")'
);

const shim = `<script>
// google.script.run 互換層: 画面コードはそのまま、Apps Script の JSON API (fetch) を呼ぶ。
// 共有キーは共有URLの #k=... で受け取り、ブラウザに保存する(ページのソースには含めない)。
(function () {
  const API_URL = ${JSON.stringify(apiUrl)};
  const WRITE_FUNCTIONS = ["linkEvent", "requestPeatixUpdate"];
  const hashKey = new URLSearchParams(location.hash.slice(1)).get("k");
  try { if (hashKey) localStorage.setItem("wpdash_key", hashKey); } catch (e) {}
  if (hashKey) history.replaceState(null, "", location.pathname + location.search);
  let key = hashKey || "";
  try { key = key || localStorage.getItem("wpdash_key") || ""; } catch (e) {}

  async function call(fn, args) {
    if (!key) throw new Error("共有URL(鍵つき)から開いてください");
    let res;
    if (WRITE_FUNCTIONS.includes(fn)) {
      // text/plain にすると事前確認(プリフライト)なしで送れる。
      res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ fn, args, key }) });
    } else {
      res = await fetch(API_URL + "?api=" + encodeURIComponent(fn) + "&args=" + encodeURIComponent(JSON.stringify(args)) + "&key=" + encodeURIComponent(key));
    }
    const json = await res.json();
    if (json.error) throw new Error(json.message || "サーバーエラー");
    return json.result;
  }

  function chain(onSuccess, onFailure) {
    return new Proxy({}, {
      get(_, name) {
        if (name === "withSuccessHandler") return (fn) => chain(fn, onFailure);
        if (name === "withFailureHandler") return (fn) => chain(onSuccess, fn);
        return (...args) => {
          call(name, args).then((result) => (onSuccess || (() => {}))(result)).catch((err) => (onFailure || (() => {}))(err));
        };
      }
    });
  }
  window.google = { script: { run: chain(null, null) } };
})();
</script>
`;

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Wonder+ 集客状況ダッシュボード</title>
</head>
<body>
${shim}
${body}
</body>
</html>
`;

const out = path.resolve("docs", "index.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`作成しました: ${out} (元: ${source})`);
