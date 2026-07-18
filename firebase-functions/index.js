"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

initializeApp();
// 患者の健康データ（体重・食事・運動・検査）が入るFirestore（databaseId "patients"）。
// ドキュメントIDは研究用ID（対面QR登録時にProject Bの対応表と一緒に発行されるランダムUUID）。
const mainDb = getFirestore("patients");
const authAdmin = getAuth();

// Set with: firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const MODEL = "gemini-flash-latest";

// 対応表専用プロジェクト（別Firebaseプロジェクト）のCloud Functionsを叩くための
// 共有シークレットとベースURL。値は両プロジェクトに同じものを設定する。
// firebase functions:secrets:set MAPPING_API_KEY --project kancare-8a0d1
// firebase functions:secrets:set MAPPING_API_KEY --project <mapping project id>
const MAPPING_API_KEY = defineSecret("MAPPING_API_KEY");
const MAPPING_BASE_URL = defineSecret("MAPPING_BASE_URL"); // 例: https://asia-northeast1-<mapping-project>.cloudfunctions.net

const RP_NAME = "かん活";
const RP_ID = "zhimasongtian-spec.github.io";
const ORIGIN = "https://zhimasongtian-spec.github.io";

// 肝ケア日記の「写真でカロリー判定」用の中継プロキシ。
// APIキー未設定の端末から呼ばれ、Geminiのレスポンスをそのまま返す
// （index.html 側の解析ロジックは apiKey 直叩きと同じ形で処理できる）。
exports.mealProxy = onRequest(
  { secrets: [GEMINI_API_KEY], cors: true, region: "asia-northeast1", memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    const { image, prompt } = req.body || {};
    if (!image || !prompt) {
      res.status(400).json({ error: { message: "image and prompt are required" } });
      return;
    }
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY.value())}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: image } }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        }
      );
      const data = await geminiRes.json();
      res.status(geminiRes.status).json(data);
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

// ------- 共通ヘルパー -------

async function requireAuth(req, res) {
  const authHeader = req.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: { message: "missing auth token" } });
    return null;
  }
  try {
    return await authAdmin.verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: { message: "invalid auth token" } });
    return null;
  }
}

const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

// スタッフの「重要操作」の直前に、直近の再認証（パスワード再入力 or WebAuthn）が
// 済んでいることを確認する。auth_timeが新しい（=ちょうどreauthenticateした）か、
// webauthnStepUpsに直近のWebAuthn成功記録があればOKとする。
async function requireRecentStaffStepUp(decoded, res) {
  if (decoded.role !== "staff") {
    res.status(403).json({ error: { message: "staff role required" } });
    return false;
  }
  const now = Date.now();
  const authTimeMs = (decoded.auth_time || 0) * 1000;
  if (now - authTimeMs <= STEP_UP_WINDOW_MS) return true;
  const stepUpDoc = await mainDb.collection("webauthnStepUps").doc(decoded.uid).get();
  const steppedUpAt = stepUpDoc.exists ? stepUpDoc.data().steppedUpAt : 0;
  if (now - steppedUpAt <= STEP_UP_WINDOW_MS) return true;
  res.status(401).json({ error: { message: "step-up reauthentication required", code: "step_up_required" } });
  return false;
}

async function callMappingFunction(name, body) {
  const url = `${MAPPING_BASE_URL.value()}/${name}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mapping-key": MAPPING_API_KEY.value() },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `mapping function ${name} failed`);
  return data;
}

const REGISTRATION_TOKEN_TTL_MS = 10 * 60 * 1000;

// ------- 患者登録・再連携（対面QR方式） -------

// スタッフによる新規患者登録:
// {hospitalId, hospitalPatientNo} を受け取り、対応表専用プロジェクトに新しい
// 研究用IDを発行してもらい、患者データ領域を用意し、QRコード化する
// ワンタイムトークンを返す。重要操作なのでステップアップ認証を要求する。
exports.staffRegisterPatient = onRequest(
  { secrets: [MAPPING_API_KEY, MAPPING_BASE_URL], cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    const decoded = await requireAuth(req, res);
    if (!decoded) return;
    if (!(await requireRecentStaffStepUp(decoded, res))) return;

    const { hospitalId, hospitalPatientNo } = req.body || {};
    if (!hospitalId || !hospitalPatientNo) {
      res.status(400).json({ error: { message: "hospitalId and hospitalPatientNo are required" } });
      return;
    }
    try {
      const { researchId } = await callMappingFunction("issueMapping", {
        hospitalId, hospitalPatientNo, registeredBy: decoded.uid,
      });
      await mainDb.collection("patients").doc(researchId).set({ createdAt: Date.now() });
      const token = crypto.randomUUID();
      await mainDb.collection("pendingRegistrations").doc(token).set({
        researchId, createdAt: Date.now(), expiresAt: Date.now() + REGISTRATION_TOKEN_TTL_MS, used: false,
      });
      res.status(200).json({ token });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

// スタッフによる既存患者の再連携:
// 院内患者番号から対応表を検索して既存の研究用IDを取得し、その研究用IDに
// 紐づく新しいワンタイムトークンを発行する（新しい研究用IDは発行しない）。
// 旧端末のセッションは無効化する。
exports.staffRelinkPatient = onRequest(
  { secrets: [MAPPING_API_KEY, MAPPING_BASE_URL], cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    const decoded = await requireAuth(req, res);
    if (!decoded) return;
    if (!(await requireRecentStaffStepUp(decoded, res))) return;

    const { hospitalId, hospitalPatientNo } = req.body || {};
    if (!hospitalId || !hospitalPatientNo) {
      res.status(400).json({ error: { message: "hospitalId and hospitalPatientNo are required" } });
      return;
    }
    try {
      let researchId;
      try {
        ({ researchId } = await callMappingFunction("lookupMapping", { hospitalId, hospitalPatientNo }));
      } catch {
        res.status(404).json({ error: { message: "この院内患者番号の患者は見つかりませんでした。新規登録をご利用ください" } });
        return;
      }
      const token = crypto.randomUUID();
      await mainDb.collection("pendingRegistrations").doc(token).set({
        researchId, createdAt: Date.now(), expiresAt: Date.now() + REGISTRATION_TOKEN_TTL_MS, used: false,
      });
      // 旧端末のログインセッションを無効化（紛失端末からの不正アクセス対策）。
      await authAdmin.revokeRefreshTokens(researchId).catch(() => {});
      res.status(200).json({ token });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

// 患者アプリがQRコードをスキャンした後に呼ぶ: ワンタイムトークンを検証し、
// 研究用ID（uid）でサインインするためのカスタムトークンを返す。
exports.confirmRegistration = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    const { token } = req.body || {};
    if (!token) {
      res.status(400).json({ error: { message: "token is required" } });
      return;
    }
    try {
      const ref = mainDb.collection("pendingRegistrations").doc(token);
      const doc = await ref.get();
      if (!doc.exists) {
        res.status(404).json({ error: { message: "このQRコードは無効です" } });
        return;
      }
      const data = doc.data();
      if (data.used || data.expiresAt < Date.now()) {
        res.status(410).json({ error: { message: "このQRコードは期限切れです。医師にもう一度発行してもらってください" } });
        return;
      }
      await ref.set({ used: true, usedAt: Date.now() }, { merge: true });
      const customToken = await authAdmin.createCustomToken(data.researchId, { role: "patient" });
      res.status(200).json({ token: customToken });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

// ------- WebAuthn（生体認証）: 患者・医師共通 -------
// 端末解錠用の生体認証（Touch ID/Face ID/Windows Hello等）を登録・検証する。
// これはあくまで端末ロック画面の代わりであり、実際の認可はFirebase Authの
// 永続セッション（confirmRegistration/メールログインで発行済み）が担う。
// staffの重要操作向けには、認証成功時刻をwebauthnStepUpsに記録し、
// requireRecentStaffStepUpのステップアップ判定に使う。

exports.webauthnRegisterOptions = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: { message: "Method Not Allowed" } }); return; }
    const decoded = await requireAuth(req, res);
    if (!decoded) return;
    try {
      const userID = crypto.createHash("sha256").update(decoded.uid).digest();
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userID,
        userName: decoded.role === "staff" ? (decoded.email || decoded.uid) : "患者",
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred", authenticatorAttachment: "platform" },
      });
      await mainDb.collection("webauthnChallenges").doc(decoded.uid).set({
        challenge: options.challenge, createdAt: Date.now(),
      });
      res.status(200).json(options);
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

exports.webauthnRegisterVerify = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: { message: "Method Not Allowed" } }); return; }
    const decoded = await requireAuth(req, res);
    if (!decoded) return;
    try {
      const challengeDoc = await mainDb.collection("webauthnChallenges").doc(decoded.uid).get();
      if (!challengeDoc.exists) { res.status(400).json({ error: { message: "no pending challenge" } }); return; }
      const expectedChallenge = challengeDoc.data().challenge;
      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });
      if (!verification.verified || !verification.registrationInfo) {
        res.status(400).json({ error: { message: "verification failed" } });
        return;
      }
      const { credential } = verification.registrationInfo;
      const credRef = mainDb.collection("webauthnCredentials").doc(decoded.uid);
      const credDoc = await credRef.get();
      const existing = credDoc.exists ? (credDoc.data().credentials || []) : [];
      existing.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64"),
        counter: credential.counter,
        transports: credential.transports || [],
      });
      await credRef.set({ credentials: existing }, { merge: true });
      await mainDb.collection("webauthnChallenges").doc(decoded.uid).delete();
      res.status(200).json({ verified: true });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

exports.webauthnAuthOptions = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: { message: "Method Not Allowed" } }); return; }
    const decoded = await requireAuth(req, res);
    if (!decoded) return;
    try {
      const credDoc = await mainDb.collection("webauthnCredentials").doc(decoded.uid).get();
      const credentials = credDoc.exists ? (credDoc.data().credentials || []) : [];
      if (credentials.length === 0) {
        res.status(404).json({ error: { message: "no credential registered" } });
        return;
      }
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: "preferred",
        allowCredentials: credentials.map(c => ({ id: c.id, transports: c.transports })),
      });
      await mainDb.collection("webauthnChallenges").doc(decoded.uid).set({
        challenge: options.challenge, createdAt: Date.now(),
      });
      res.status(200).json(options);
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

exports.webauthnAuthVerify = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: { message: "Method Not Allowed" } }); return; }
    const decoded = await requireAuth(req, res);
    if (!decoded) return;
    try {
      const challengeDoc = await mainDb.collection("webauthnChallenges").doc(decoded.uid).get();
      if (!challengeDoc.exists) { res.status(400).json({ error: { message: "no pending challenge" } }); return; }
      const expectedChallenge = challengeDoc.data().challenge;
      const credRef = mainDb.collection("webauthnCredentials").doc(decoded.uid);
      const credDoc = await credRef.get();
      const credentials = credDoc.exists ? (credDoc.data().credentials || []) : [];
      const match = credentials.find(c => c.id === req.body.id);
      if (!match) { res.status(400).json({ error: { message: "unknown credential" } }); return; }
      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: match.id, publicKey: Buffer.from(match.publicKey, "base64"), counter: match.counter, transports: match.transports },
      });
      if (!verification.verified) { res.status(400).json({ error: { message: "verification failed" } }); return; }
      match.counter = verification.authenticationInfo.newCounter;
      await credRef.set({ credentials }, { merge: true });
      await mainDb.collection("webauthnChallenges").doc(decoded.uid).delete();
      await mainDb.collection("webauthnStepUps").doc(decoded.uid).set({ steppedUpAt: Date.now() });
      res.status(200).json({ verified: true });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);
