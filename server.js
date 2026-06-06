// server.js — Hartaku Backend
// v1.5 — Image support + compression

import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import twilio from "twilio";
import sharp from "sharp";
import fetch from "node-fetch";
import { chat } from "./anthropic.js";

// ============================================
// FETCH KURS REAL-TIME — frankfurter.app (gratis, no API key)
// ============================================
let kursCache = { data: null, timestamp: 0 };

async function fetchKursTerkini() {
  const now = Date.now();
  // Cache 1 jam — tidak perlu fetch setiap pesan
  if (kursCache.data && (now - kursCache.timestamp) < 3600000) {
    return kursCache.data;
  }
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=IDR,SGD,EUR,MYR");
    const data = await res.json();
    const rates = data.rates;
    const kursText = `Data kurs terkini (sumber: ECB via Frankfurter, diupdate harian):
- USD 1 = IDR ${rates.IDR?.toLocaleString('id-ID') || 'tidak tersedia'}
- SGD 1 = IDR ${Math.round((rates.IDR / rates.SGD) || 0).toLocaleString('id-ID')}
- EUR 1 = IDR ${Math.round((rates.IDR / rates.EUR) || 0).toLocaleString('id-ID')}
- MYR 1 = IDR ${Math.round((rates.IDR / rates.MYR) || 0).toLocaleString('id-ID')}
Catatan: Untuk kurs real-time per menit, klien dapat cek di Google Finance atau aplikasi bank.`;
    kursCache = { data: kursText, timestamp: now };
    return kursText;
  } catch (err) {
    console.error("[Kurs] Gagal fetch kurs:", err);
    return "Data kurs sedang tidak tersedia — minta klien cek di Google Finance atau aplikasi bank untuk kurs terkini.";
  }
}
import {
  getOrCreateSession,
  checkAndIncrementLimit,
  touchSession,
  getMessages,
  saveMessage,
  clearSession,
} from "./supabase.js";

const app = express();
const PORT = process.env.PORT || 3000;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ============================================
// HELPER: Pecah pesan panjang
// ============================================
function splitMessage(text, maxLength = 800) {
  if (text.length <= maxLength) return [text];
  const parts = [];
  const paragraphs = text.split('\n\n');
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length > maxLength) {
      if (current) parts.push(current.trim());
      current = paragraph;
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph;
    }
  }
  if (current) parts.push(current.trim());
  return parts.filter(p => p.length > 0);
}

// ============================================
// HELPER: Download & kompres gambar dari Twilio
// ============================================
async function downloadAndCompressImage(mediaUrl) {
  try {
    // Download gambar dari Twilio dengan auth
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const response = await fetch(mediaUrl, {
      headers: { Authorization: authHeader }
    });

    if (!response.ok) throw new Error(`Gagal download gambar: ${response.status}`);

    const buffer = await response.buffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Kompres dengan Sharp — max 1200px, quality 85%
    const compressed = await sharp(buffer)
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    const base64 = compressed.toString('base64');

    console.log(`[Image] Original: ${buffer.length} bytes → Compressed: ${compressed.length} bytes`);

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: base64
      }
    };
  } catch (err) {
    console.error('[Image] Error processing image:', err);
    return null;
  }
}

// ============================================
// MIDDLEWARE
// ============================================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes("*")) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin tidak diizinkan: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-session-id", "x-api-secret"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Hartaku Backend", version: "1.6.0" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================
// POST /chakra/webhook — WhatsApp via Chakra Chat
// ============================================
app.post("/chakra/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const body = req.body;

    // Format Meta pass-through webhook
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const from = message.from; // nomor pengirim, format: 628xxx
    const incomingMsg = message?.text?.body?.trim() || "";
    const messageType = message.type;

    if (!from) return;

    console.log(`[Chakra] Pesan dari ${from}: "${incomingMsg}" (type: ${messageType})`);

    const sessionId = from;
    const CHAKRA_PHONE = process.env.CHAKRA_PHONE_NUMBER_ID;
    const CHAKRA_TOKEN = process.env.CHAKRA_ACCESS_TOKEN;

    await getOrCreateSession(sessionId, { platform: "whatsapp", phoneNumber: sessionId });

    // Cek daily limit
    const limitCheck = await checkAndIncrementLimit(sessionId);
    if (!limitCheck.allowed) {
      console.log(`[Limit] Sesi ${sessionId} sudah mencapai batas 60 pesan hari ini`);
      await sendChakraMessage(CHAKRA_PHONE, CHAKRA_TOKEN, from,
        "Anda telah mencapai batas percakapan hari ini. Untuk melanjutkan tanpa batas, upgrade ke Hartaku Premier. Sampai jumpa besok.");
      return;
    }

    const history = await getMessages(sessionId);
    const messageContent = [];

    // Proses gambar
    if (messageType === "image" && message.image) {
      const mediaId = message.image.id;
      const imageBlock = await downloadChakraImage(mediaId, CHAKRA_TOKEN);
      if (imageBlock) messageContent.push(imageBlock);
    }

    if (incomingMsg) {
      messageContent.push({ type: "text", text: incomingMsg });
    } else if (messageContent.length > 0) {
      messageContent.push({ type: "text", text: "Saya mengirimkan gambar/dokumen ini untuk dianalisa." });
    }

    if (messageContent.length === 0) return;

    const userMessage = messageContent.length === 1 && messageContent[0].type === "text"
      ? messageContent[0].text
      : messageContent;

    const chatHistory = [...history, { role: "user", content: userMessage }];
    const savedContent = incomingMsg || "[Gambar/Dokumen]";
    await saveMessage(sessionId, "user", savedContent);

    const kursContext = await fetchKursTerkini();
    const reply = await chat(chatHistory, kursContext);
    await saveMessage(sessionId, "assistant", reply);
    await touchSession(sessionId);

    // Kirim balasan via Chakra API
    const parts = splitMessage(reply, 800);
    for (const part of parts) {
      await sendChakraMessage(CHAKRA_PHONE, CHAKRA_TOKEN, from, part);
      if (parts.length > 1) await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[Chakra] Balasan terkirim ke ${from} (${parts.length} bagian)`);
  } catch (err) {
    console.error("[Chakra] Error:", err);
  }
});

// ============================================
// HELPER: Kirim pesan via Chakra API
// ============================================
async function sendChakraMessage(phoneNumberId, accessToken, to, text) {
  const pluginId = process.env.CHAKRA_PLUGIN_ID;
  const apiVersion = "v19.0";
  
  const res = await fetch(`https://api.chakrahq.com/v1/ext/plugin/whatsapp/${pluginId}/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });
  const data = await res.json();
  if (!res.ok) console.error("[Chakra] Gagal kirim pesan:", data);
  return data;
}

// ============================================
// HELPER: Download gambar dari Chakra/Meta
// ============================================
async function downloadChakraImage(mediaId, accessToken) {
  try {
    // Ambil URL gambar dari Meta
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const metaData = await metaRes.json();
    if (!metaData.url) return null;

    // Download gambar
    const imgRes = await fetch(metaData.url, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const buffer = await imgRes.buffer();

    // Kompres dengan Sharp
    const compressed = await sharp(buffer)
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    return {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: compressed.toString("base64")
      }
    };
  } catch (err) {
    console.error("[Chakra] Error download gambar:", err);
    return null;
  }
}

// POST /twilio/webhook
// ============================================
app.post("/twilio/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const incomingMsg = req.body.Body?.trim() || "";
    const from = req.body.From;
    const to = req.body.To;
    const numMedia = parseInt(req.body.NumMedia || "0");

    if (!from) return;
    if (!incomingMsg && numMedia === 0) return;

    console.log(`[Twilio] Pesan dari ${from}: "${incomingMsg}" (${numMedia} media)`);

    const sessionId = from.replace("whatsapp:", "");
    await getOrCreateSession(sessionId, { platform: "whatsapp", phoneNumber: sessionId });

    // Cek daily limit
    const limitCheck = await checkAndIncrementLimit(sessionId);
    if (!limitCheck.allowed) {
      console.log(`[Limit] Sesi ${sessionId} sudah mencapai batas ${60} pesan hari ini`);
      await twilioClient.messages.create({
        from: to,
        to: from,
        body: "Anda telah mencapai batas percakapan hari ini. Untuk melanjutkan tanpa batas, upgrade ke Hartaku Premier. Sampai jumpa besok."
      });
      return;
    }

    const history = await getMessages(sessionId);

    // Bangun konten pesan — bisa teks + gambar
    const messageContent = [];

    // Proses gambar kalau ada
    if (numMedia > 0) {
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const mediaType = req.body[`MediaContentType${i}`] || "";

        if (mediaType.startsWith("image/") && mediaUrl) {
          console.log(`[Image] Memproses gambar ${i + 1}/${numMedia}: ${mediaUrl}`);
          const imageBlock = await downloadAndCompressImage(mediaUrl);
          if (imageBlock) {
            messageContent.push(imageBlock);
          }
        }
      }
    }

    // Tambahkan teks
    if (incomingMsg) {
      messageContent.push({ type: "text", text: incomingMsg });
    } else if (messageContent.length > 0) {
      // Ada gambar tapi tidak ada teks — tambahkan instruksi default
      messageContent.push({
        type: "text",
        text: "Saya mengirimkan gambar/dokumen ini untuk dianalisa."
      });
    }

    if (messageContent.length === 0) return;

    // Format pesan untuk API
    const userMessage = messageContent.length === 1 && messageContent[0].type === "text"
      ? messageContent[0].text
      : messageContent;

    const messages = [...history, { role: "user", content: userMessage }];

    // Simpan pesan teks di database
    const savedContent = incomingMsg || "[Gambar/Dokumen]";
    await saveMessage(sessionId, "user", savedContent);

    const kursContext = await fetchKursTerkini();
    const reply = await chat(messages, kursContext);
    await saveMessage(sessionId, "assistant", reply);
    await touchSession(sessionId);

    // Kirim balasan
    const parts = splitMessage(reply, 800);
    for (const part of parts) {
      await twilioClient.messages.create({ from: to, to: from, body: part });
      if (parts.length > 1) await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[Twilio] Balasan terkirim ke ${from} (${parts.length} bagian)`);
  } catch (err) {
    console.error("[Twilio] Error:", err);
    try {
      await twilioClient.messages.create({
        from: req.body.To,
        to: req.body.From,
        body: "Maaf, ada kendala teknis. Silakan coba lagi.",
      });
    } catch (e) {
      console.error("[Twilio] Gagal kirim pesan error:", e);
    }
  }
});

// ============================================
// POST /chat — endpoint JSX
// ============================================
function requireSecret(req, res, next) {
  const secret = req.headers["x-api-secret"];
  if (!process.env.API_SECRET) return next();
  if (secret !== process.env.API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.post("/chat", requireSecret, async (req, res) => {
  try {
    const { message, sessionId: clientSessionId } = req.body;
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "Message tidak boleh kosong" });
    }
    const sessionId = clientSessionId || uuidv4();
    await getOrCreateSession(sessionId, { platform: "web" });
    const history = await getMessages(sessionId);
    const messages = [...history, { role: "user", content: message.trim() }];
    await saveMessage(sessionId, "user", message.trim());
    const reply = await chat(messages);
    await saveMessage(sessionId, "assistant", reply);
    await touchSession(sessionId);
    res.json({ reply, sessionId });
  } catch (err) {
    console.error("[/chat] Error:", err);
    res.status(500).json({ error: "Terjadi kesalahan server", reply: "Maaf, ada kendala teknis." });
  }
});

app.post("/reset", requireSecret, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId diperlukan" });
    await clearSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Gagal menghapus sesi" });
  }
});

app.use((err, req, res, _next) => {
  console.error("[Server] Error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║        HARTAKU BACKEND v1.6          ║
║  Warisan · Hukum · Keuangan Keluarga ║
╠══════════════════════════════════════╣
║  Port     : ${String(PORT).padEnd(25)}║
║  Twilio   : ${(process.env.TWILIO_ACCOUNT_SID ? "✅ terhubung" : "❌ belum").padEnd(25)}║
║  Supabase : ${(process.env.SUPABASE_URL ? "✅ terhubung" : "❌ belum").padEnd(25)}║
║  Anthropic: ${(process.env.ANTHROPIC_API_KEY ? "✅ terhubung" : "❌ belum").padEnd(25)}║
║  Images   : ✅ Sharp compression      ║
╚══════════════════════════════════════╝
  `);
});

export default app;
