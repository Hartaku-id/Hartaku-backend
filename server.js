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
import {
  getOrCreateSession,
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
  res.json({ status: "ok", service: "Hartaku Backend", version: "1.5.0" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================
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

    const reply = await chat(messages);
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
║        HARTAKU BACKEND v1.5          ║
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
