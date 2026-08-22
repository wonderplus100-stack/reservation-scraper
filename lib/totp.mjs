import { TOTP, Secret } from "otpauth";

// secret は認証アプリ登録時にQRコードと一緒に表示される Base32 文字列
// (例: "JBSWY3DPEHPK3PXP")。QR画像しか表示されない場合は「テキストで表示」
// 「セットアップキーを表示」等のリンクから取得できることが多い。
export function generateTotpCode(base32Secret) {
  if (!base32Secret) return null;
  const totp = new TOTP({
    secret: Secret.fromBase32(base32Secret.replace(/\s+/g, "")),
    digits: 6,
    period: 30
  });
  return totp.generate();
}
