import fs from "node:fs";
import { storageStatePath } from "../lib/browser.mjs";

// scripts/peatix-manual-login.mjs でユーザーの手元PCで手動ログインして
// 保存したセッション(storage-state)を、GitHub Secretsに登録した内容から
// GitHub Actions実行環境のファイルとして書き戻す。
//
// GitHub Actionsのキャッシュ(storage-state)には、前回までの実行で
// 自然に更新されたセッション情報が入っている可能性があるため、既に
// ファイルが存在する場合は上書きしない(キャッシュの方を優先する)。
// ファイルが無い場合(初回、またはキャッシュが失効/削除された場合)のみ
// Secretsの内容で初期化する。セッションが無効になり再ログインした後、
// 新しいSecretの内容を確実に使わせたい場合は、GitHub Actionsの
// storage-stateキャッシュを一度削除してから実行すること。
for (const index of [1, 2]) {
  const accountLabel = process.env[`PEATIX_${index}_ACCOUNT_LABEL`] || `Peatix${index}`;
  const stateJson = process.env[`PEATIX_${index}_STORAGE_STATE`];
  if (!stateJson) continue;

  const statePath = storageStatePath(`peatix-${accountLabel}`);
  if (fs.existsSync(statePath)) {
    console.log(`Peatix(${accountLabel}): 既存のセッションファイルがあるためスキップ: ${statePath}`);
    continue;
  }
  fs.writeFileSync(statePath, stateJson, "utf8");
  console.log(`Peatix(${accountLabel})のセッションを初期化しました: ${statePath}`);
}
