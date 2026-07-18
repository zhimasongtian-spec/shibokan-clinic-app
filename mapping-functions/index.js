"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

// Project A（患者データ本体）とこのプロジェクトを繋ぐ共有シークレット。
// Project A のCloud Functionsだけがこの値を知っていて、クライアントは一切知らない。
// 設定: firebase functions:secrets:set MAPPING_API_KEY --project <このプロジェクトのID>
// （Project A側にも同じ値を同名で設定する）
const MAPPING_API_KEY = defineSecret("MAPPING_API_KEY");

function checkKey(req, res) {
  const key = req.get("x-mapping-key") || "";
  if (key !== MAPPING_API_KEY.value()) {
    res.status(401).json({ error: { message: "invalid mapping key" } });
    return false;
  }
  return true;
}

// 病院ID＋院内患者番号 から新しい研究用IDを発行し、対応表に登録する。
// Project AのstaffRegisterPatientからのみ呼ばれる（クライアントから直接は呼べない）。
exports.issueMapping = onRequest(
  { secrets: [MAPPING_API_KEY], cors: false, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    if (!checkKey(req, res)) return;
    const { hospitalId, hospitalPatientNo, registeredBy } = req.body || {};
    if (!hospitalId || !hospitalPatientNo) {
      res.status(400).json({ error: { message: "hospitalId and hospitalPatientNo are required" } });
      return;
    }
    try {
      const researchId = crypto.randomUUID();
      await db.collection("mappings").doc(researchId).set({
        hospitalId,
        hospitalPatientNo,
        registeredBy: registeredBy || null,
        createdAt: Date.now(),
      });
      res.status(200).json({ researchId });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);

// 病院ID＋院内患者番号から既存の研究用IDを検索する（再連携用）。
exports.lookupMapping = onRequest(
  { secrets: [MAPPING_API_KEY], cors: false, region: "asia-northeast1", memory: "128MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: { message: "Method Not Allowed" } });
      return;
    }
    if (!checkKey(req, res)) return;
    const { hospitalId, hospitalPatientNo } = req.body || {};
    if (!hospitalId || !hospitalPatientNo) {
      res.status(400).json({ error: { message: "hospitalId and hospitalPatientNo are required" } });
      return;
    }
    try {
      const snap = await db.collection("mappings")
        .where("hospitalId", "==", hospitalId)
        .where("hospitalPatientNo", "==", hospitalPatientNo)
        .limit(1)
        .get();
      if (snap.empty) {
        res.status(404).json({ error: { message: "no mapping found for this patient" } });
        return;
      }
      res.status(200).json({ researchId: snap.docs[0].id });
    } catch (err) {
      res.status(500).json({ error: { message: String((err && err.message) || err) } });
    }
  }
);
