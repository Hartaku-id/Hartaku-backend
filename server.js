// server.js — Hartaku Backend utama
// Node.js + Express | Railway deployment
// v1.1 — Twilio WhatsApp aktif

import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import twilio from "twilio";
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

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ============================================
// MIDDLEWARE
// ============================================

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes("*")) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin tidak diizinkan: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-session-id", "x-api-secret"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// HEALTH CHECK
// ============================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Hartaku Backend",
    version: "1.1.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================
// POST /twilio/webhook — WhatsApp via Twilio
// ============================================

app.post("/twilio/webhook", async (req, res) => {
  // Balas 200 ke Twilio dulu agar tidak timeout
  res.status(200).send("OK");

  try {
    const incomingMsg = req.body.Body?.trim();
    const from = req.body.From; // format: whatsapp:+628xxx
    const to = req.body.To;     // format: whatsapp:+14155238886

    if (!incomingMsg || !from) {
      console.log("[Twilio] Pesan kosong atau tidak valid");
      return;
    }

    console.log(`[Twilio] Pesan masuk dari ${from}: ${incomingMsg}`);

    // Gunakan nomor WA sebagai session ID
    const sessionId = from.replace("whatsapp:", "");

    // Pastikan sesi ada
    await getOrCreateSession(sessionId, {
      platform: "whatsapp",
      phoneNumber: sessionId,
    });

    // Ambil riwayat percakapan
    const history = await getMessages(sessionId);

    // Tambahkan pesan baru
    const messages = [...history, { role: "user", content: incomingMsg }];

    // Simpan pesan user
    await saveMessage(sessionId, "user", incomingMsg);

    // Kirim ke Anthropic
    const reply = await chat(messages);

    // Simpan balasan
    await saveMessage(sessionId, "assistant", reply);
    await touchSession(sessionId);

    // Kirim balasan ke WhatsApp via Twilio
    await twilioClient.messages.create({
      from: to,
      to: from,
      body: reply,
    });

    console.log(`[Twilio] Balasan terkirim ke ${from}`);
  } catch (err) {
    console.error("[Twilio] Error:", err);

    // Coba kirim pesan error ke user
    try {
      await twilioClient.messages.create({
        from: req.body.To,
        to: req.body.From,
        body: "Maaf, ada kendala teknis. Silakan coba lagi.",
      });
    } catch (sendErr) {
      console.error("[Twilio] Gagal kirim pesan error:", sendErr);
    }
  }
});

// ============================================
// POST /chat — endpoint frontend JSX
// ============================================

function requireSecret(req, res, next) {
  const secret = req.headers["x-api-secret"];
  if (!process.env.API_SECRET) {
    return next();
  }
  if (secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
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
    res.status(500).json({
      error: "Terjadi kesalahan server",
      reply: "Maaf, ada kendala teknis. Silakan coba lagi.",
    });
  }
});

app.post("/reset", requireSecret, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId diperlukan" });
    }
    await clearSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error("[/reset] Error:", err);
    res.status(500).json({ error: "Gagal menghapus sesi" });
  }
});

// ============================================
// ERROR HANDLER
// ============================================

app.use((err, req, res, _next) => {
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ============================================
// START
// ============================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║        HARTAKU BACKEND v1.1          ║
║  Warisan · Hukum · Keuangan Keluarga ║
╠══════════════════════════════════════╣
║  Port    : ${String(PORT).padEnd(26)}║
║  Twilio  : ${(process.env.TWILIO_ACCOUNT_SID ? "✅ terhubung" : "❌ belum di-set").padEnd(26)}║
║  Supabase: ${(process.env.SUPABASE_URL ? "✅ terhubung" : "❌ belum di-set").padEnd(26)}║
║  Anthropic: ${(process.env.ANTHROPIC_API_KEY ? "✅ terhubung" : "❌ belum di-set").padEnd(25)}║
╚══════════════════════════════════════╝
  `);
});

export default app;
