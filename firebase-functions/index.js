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

// 患者ログイン: アプリID(4桁)＋生年月日で本人確認し、カスタムトークンを発行する。
// 病院ID・氏名は一切扱わない（mainDbにはアプリIDと生年月日しか無い）。
exports.patientLogin = onRequest(
  { cors: true, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    const { appId, birthdate } = req.body || {};
    if (!/^\d{4}$/.test(appId || "") || !birthdate) {
      res.status(400).json({ error: { message: "appId and birthdate are required" } });
      return;
    }
    const ref = mainDb.collection("patients").doc(appId);
    try {
      const doc = await ref.get();
      if (!doc.exists) {
        res.status(401).json({ error: { message: "invalid credentials" } });
        return;
      }
      const data = doc.data();
      const now = Date.now();
      if (data.lockUntil && data.lockUntil > now) {
        res.status(429).json({ error: { message: "too many attempts, try again later" } });
        return;
      }
      if (data.birthdate !== birthdate) {
        const failedAttempts = (data.failedAttempts || 0) + 1;
        const update = { failedAttempts };
        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
          update.lockUntil = now + LOCK_MS;
          update.failedAttempts = 0;
        }
        await ref.set(update, { merge: true });
        res.status(401).json({ error: { message: "invalid credentials" } });
        return;
      }
      await ref.set({ failedAttempts: 0, lockUntil: null }, { merge: true });
      const token = await authAdmin.createCustomToken(appId, { role: "patient" });
      res.status(200).json({ token });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

// スタッフによる新規患者登録: 病院ID＋生年月日を受け取り、新しい4桁アプリIDを発行する。
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
    const appId = phoneLast4;
    try {
      const ref = mainDb.collection("patients").doc(appId);
      const existing = await ref.get();
      if (existing.exists) {
        if (existing.data().birthdate === birthdate) {
          // 同じ電話番号下4桁・同じ生年月日 → 既に登録済みの同一患者とみなす
          res.status(200).json({ appId, alreadyRegistered: true });
          return;
        }
        res.status(409).json({
          error: { message: "この電話番号下4桁は別の患者さんが既に使用しています。電話番号をご確認ください。" },
        });
        return;
      }
      await ref.set({ birthdate, failedAttempts: 0, lockUntil: null, createdAt: Date.now() });
      await mappingDb.collection("hospitalMap").doc(appId).set({
        hospitalId, createdAt: Date.now(),
      });
      res.status(200).json({ appId, alreadyRegistered: false });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);
