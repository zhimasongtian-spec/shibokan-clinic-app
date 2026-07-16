"use strict";
// スタッフアカウント（医師・スタッフのログイン用）を作成し、role=staff の権限を付与する。
// 実行方法:
//   1. Firebaseコンソール → プロジェクトの設定 → サービスアカウント →
//      「新しい秘密鍵の生成」でJSONキーをダウンロードし、このフォルダに
//      service-account-key.json という名前で置く（Gitには含まれません）。
//   2. このフォルダで `npm install` を実行。
//   3. `node set-staff-role.js <メールアドレス> <パスワード>` を実行。
//      既にそのメールアドレスのアカウントがあれば、role=staff を付与するだけ。
const admin = require("firebase-admin");
const serviceAccount = require("./service-account-key.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error("使い方: node set-staff-role.js <メールアドレス> <パスワード>");
    process.exit(1);
  }
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log(`既存アカウントが見つかりました: ${user.uid}`);
  } catch {
    user = await admin.auth().createUser({ email, password });
    console.log(`新しいアカウントを作成しました: ${user.uid}`);
  }
  await admin.auth().setCustomUserClaims(user.uid, { role: "staff" });
  console.log(`${email} に role=staff を付与しました。`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
