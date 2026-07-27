"use strict";
// スタッフアカウント（医師・スタッフのログイン用）を作成し、role=staff の権限を付与する。
// パスワードはここでは設定しない（開発担当者がパスワードを知る状態を作らないため）。
// アカウント作成後、本人にstaff.htmlの「初めての方はこちら」からパスワード設定メールを
// 送ってもらう（またはこのスクリプトが表示するリンクを本人に伝える）。
// 実行方法:
//   1. Firebaseコンソール → プロジェクトの設定 → サービスアカウント →
//      「新しい秘密鍵の生成」でJSONキーをダウンロードし、このフォルダに
//      service-account-key.json という名前で置く（Gitには含まれません）。
//   2. このフォルダで `npm install` を実行。
//   3. `node set-staff-role.js <メールアドレス>` を実行。
//      既にそのメールアドレスのアカウントがあれば、role=staff を付与するだけ。
const admin = require("firebase-admin");
const serviceAccount = require("./service-account-key.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function main() {
  const [, , email] = process.argv;
  if (!email) {
    console.error("使い方: node set-staff-role.js <メールアドレス>");
    process.exit(1);
  }
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log(`既存アカウントが見つかりました: ${user.uid}`);
  } catch {
    user = await admin.auth().createUser({ email });
    console.log(`新しいアカウントを作成しました（パスワード未設定）: ${user.uid}`);
  }
  await admin.auth().setCustomUserClaims(user.uid, { role: "staff" });
  console.log(`${email} に role=staff を付与しました。`);

  const link = await admin.auth().generatePasswordResetLink(email);
  console.log("\nパスワード設定リンク（本人がstaff.htmlから自分でメールを送ることもできます）:");
  console.log(link);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
