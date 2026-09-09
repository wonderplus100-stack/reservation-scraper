// GOOGLE_SERVICE_ACCOUNT_JSON の client_email だけを表示する。
// これはGoogleスプレッドシートを共有する際に使うメールアドレスで、
// 秘密鍵などの機密情報は含まれない(共有先として公開して問題ない値)。
const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const credentials = JSON.parse(raw);
console.log(credentials.client_email);
