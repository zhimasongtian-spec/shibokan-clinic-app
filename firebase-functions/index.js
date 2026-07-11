"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

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
