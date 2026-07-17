"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
// 患者の健康データ（体重・食事・運動・検査）が入るFirestore（databaseId "patients"）。
const mainDb = getFirestore("patients");
// 病院ID⇔アプリIDの対応表専用の、別のFirestoreデータベース（databaseId "mapping"）。
// どちらもFirebaseコンソールの「Firestore Database」で事前に作成しておく必要があります
// （"(default)" ではなく、"patients" と "mapping" という名前で作成してください）。
const mappingDb = getFirestore("mapping");
const authAdmin = getAuth();

// Set with: firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const MODEL = "gemini-flash-latest";

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

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
// 電話番号下4桁＋生年月日を組み合わせた文字列を、そのままデータの保存キーにする。
// 「IDを発行する」という別概念を持たず、この2つの値だけで患者データを管理する。
const patientKey = (phoneLast4, birthdate) => `${phoneLast4}_${birthdate}`;

// 患者ログイン: 電話番号下4桁＋生年月日で本人確認し、カスタムトークンを発行する。
// 病院ID・氏名は一切扱わない（mainDbには電話番号下4桁と生年月日の組み合わせしか無い）。
exports.patientLogin = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    const { phoneLast4, birthdate } = req.body || {};
    if (!/^\d{4}$/.test(phoneLast4 || "") || !birthdate) {
      res.status(400).json({ error: { message: "phoneLast4 and birthdate are required" } });
      return;
    }
    // 総当たり対策: 失敗回数は電話番号下4桁単位でカウントする
    // （生年月日を変えて何度も試されるのを防ぐため、患者データ本体とは別に記録）。
    const attemptsRef = mainDb.collection("loginAttempts").doc(phoneLast4);
    try {
      const attemptsDoc = await attemptsRef.get();
      const attemptsData = attemptsDoc.exists ? attemptsDoc.data() : {};
      const now = Date.now();
      if (attemptsData.lockUntil && attemptsData.lockUntil > now) {
        res.status(429).json({ error: { message: "too many attempts, try again later" } });
        return;
      }
      const key = patientKey(phoneLast4, birthdate);
      const patientDoc = await mainDb.collection("patients").doc(key).get();
      if (!patientDoc.exists) {
        const failedAttempts = (attemptsData.failedAttempts || 0) + 1;
        const update = { failedAttempts };
        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
          update.lockUntil = now + LOCK_MS;
          update.failedAttempts = 0;
        }
        await attemptsRef.set(update, { merge: true });
        res.status(401).json({ error: { message: "invalid credentials" } });
        return;
      }
      await attemptsRef.set({ failedAttempts: 0, lockUntil: null }, { merge: true });
      const token = await authAdmin.createCustomToken(key, { role: "patient" });
      res.status(200).json({ token });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

// スタッフによる新規患者登録: 病院ID・生年月日・電話番号下4桁を受け取り、
// 電話番号下4桁＋生年月日をキーとして患者データ領域を用意する。
// 呼び出し元がrole=staffのカスタムクレームを持つことを検証してから実行する。
exports.staffRegisterPatient = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    const authHeader = req.get("Authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ error: { message: "missing auth token" } });
      return;
    }
    try {
      const decoded = await authAdmin.verifyIdToken(idToken);
      if (decoded.role !== "staff") {
        res.status(403).json({ error: { message: "staff role required" } });
        return;
      }
    } catch {
      res.status(401).json({ error: { message: "invalid auth token" } });
      return;
    }
    const { hospitalId, birthdate, phoneLast4 } = req.body || {};
    if (!hospitalId || !birthdate || !/^\d{4}$/.test(phoneLast4 || "")) {
      res.status(400).json({ error: { message: "hospitalId, birthdate and a 4-digit phoneLast4 are required" } });
      return;
    }
    const key = patientKey(phoneLast4, birthdate);
    try {
      const ref = mainDb.collection("patients").doc(key);
      const existing = await ref.get();
      const alreadyRegistered = existing.exists;
      if (!alreadyRegistered) {
        await ref.set({ createdAt: Date.now() });
      }
      await mappingDb.collection("hospitalMap").doc(key).set({
        hospitalId, createdAt: Date.now(),
      }, { merge: true });
      res.status(200).json({ phoneLast4, birthdate, alreadyRegistered });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);
