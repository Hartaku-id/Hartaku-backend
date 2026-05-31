// server.js — Hartaku Backend utama
// Node.js + Express | Railway deployment
// v1.0

import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
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

// ============================================
// MIDDLEWARE
// ============================================

// CORS — hanya izinkan domain yang terdaftar
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Izinkan request tanpa origin (misal: Postman, server-to-server)
      if (!origin) return callback(null, true);
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
// MIDDLEWARE: VALIDASI API SECRET
// Melindungi endpoint dari request tidak sah
// ============================================
function requireSecret(req, res, next) {
  const secret = req.headers["x-api-secret"];
  if (!process.env.API_SECRET) {
    // Jika belum di-set, lewati (mode development)
    console.warn("[Auth] API_SECRET belum di-set — endpoint tidak terlindungi");
    return next();
  }
  if (secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ============================================
// ROUTES
// ============================================

// Health check — Railway perlu ini
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Hartaku Backend",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================
// POST /chat — endpoint utama dari JSX frontend
// ============================================
app.post("/chat", requireSecret, async (req, res) => {
  try {
    const { message, sessionId: clientSessionId } = req.body;

    // Validasi input
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "Message tidak boleh kosong" });
    }

    // Session ID: gunakan yang dikirim klien, atau buat baru
    const sessionId = clientSessionId || uuidv4();

    // Pastikan sesi ada di Supabase
    await getOrCreateSession(sessionId, { platform: "web" });

    // Ambil riwayat percakapan dari Supabase
    const history = await getMessages(sessionId);

    // Tambahkan pesan baru dari user
    const messages = [...history, { role: "user", content: message.trim() }];

    // Simpan pesan user ke Supabase
    await saveMessage(sessionId, "user", message.trim());

    // Kirim ke Anthropic
    const reply = await chat(messages);

    // Simpan balasan assistant ke Supabase
    await saveMessage(sessionId, "assistant", reply);

    // Update last_active
    await touchSession(sessionId);

    // Balas ke frontend
    res.json({
      reply,
      sessionId,
    });
  } catch (err) {
    console.error("[/chat] Error:", err);
    res.status(500).json({
      error: "Terjadi kesalahan server",
      reply: "Maaf, ada kendala teknis. Silakan coba lagi.",
    });
  }
});

// ============================================
// POST /reset — hapus sesi & riwayat
// ============================================
app.post("/reset", requireSecret, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId diperlukan" });
    }

    await clearSession(sessionId);

    res.json({ success: true, message: "Sesi berhasil dihapus" });
  } catch (err) {
    console.error("[/reset] Error:", err);
    res.status(500).json({ error: "Gagal menghapus sesi" });
  }
});

// ============================================
// POST /twilio/webhook — PLACEHOLDER
// Akan diaktifkan di Fase 2 (WhatsApp)
// ============================================
app.post("/twilio/webhook", async (req, res) => {
  // TODO: Fase 2 — Twilio WhatsApp integration
  console.log("[Twilio] Webhook received (placeholder):", req.body);
  res.status(200).send("OK");
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
║        HARTAKU BACKEND v1.0          ║
║  Warisan · Hukum · Keuangan Keluarga ║
╠══════════════════════════════════════╣
║  Port    : ${String(PORT).padEnd(26)}║
║  CORS    : ${(allowedOrigins.join(", ") || "semua (dev)").substring(0, 26).padEnd(26)}║
║  Supabase: ${(process.env.SUPABASE_URL ? "✅ terhubung" : "❌ belum di-set").padEnd(26)}║
║  Anthropic: ${(process.env.ANTHROPIC_API_KEY ? "✅ terhubung" : "❌ belum di-set").padEnd(25)}║
╚══════════════════════════════════════╝
  `);
});

export default app;
