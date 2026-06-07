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
// FETCH DATA FINANSIAL — kurs, IHSG, emas, komoditas
// ============================================
let finansialCache = { data: null, timestamp: 0 };

async function fetchKursTerkini() {
  const now = Date.now();
  // Cache 1 jam
  if (finansialCache.data && (now - finansialCache.timestamp) < 3600000) {
    return finansialCache.data;
  }

  const results = {};

  // 1. KURS — coba frankfurter.app dulu, fallback ke exchangerate-api
  try {
    const kursRes = await fetch("https://api.frankfurter.app/latest?from=USD&to=IDR,SGD,EUR,MYR,AUD,CNY,JPY");
    const contentType = kursRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('Bukan JSON');
    const kursData = await kursRes.json();
    results.kurs = kursData.rates;
    results.kursDate = kursData.date;
  } catch (e) {
    console.error("[Finansial] Gagal fetch frankfurter, coba fallback:", e.message);
    // Fallback: exchangerate-api.com (gratis, no key)
    try {
      const fallbackRes = await fetch("https://open.er-api.com/v6/latest/USD");
      const fallbackData = await fallbackRes.json();
      if (fallbackData.rates) {
        results.kurs = fallbackData.rates;
        results.kursDate = new Date().toISOString().split('T')[0];
        console.log("[Finansial] Kurs dari fallback API berhasil");
      }
    } catch (e2) {
      console.error("[Finansial] Fallback kurs juga gagal:", e2.message);
    }
  }

  // 2. IHSG, EMAS DUNIA, KOMODITAS, CRYPTO, INDEKS US — Yahoo Finance
  const yahooSymbols = [
    "^JKSE",      // IHSG
    "^LQ45.JK",   // LQ45
    "GC=F",       // Emas dunia (USD/troy oz)
    "ANTM.JK",    // Antam proxy emas Indonesia
    "PTBA.JK",    // Batu bara
    "NIKL.JK",    // Nikel Indonesia
    "TINS.JK",    // Timah Indonesia
    "SIMP.JK",    // CPO/sawit proxy
    "BTC-USD",    // Bitcoin
    "ETH-USD",    // Ethereum
    "^GSPC",      // S&P 500
    "^IXIC",      // NASDAQ
    "^DJI",       // Dow Jones
  ];

  try {
    const yahooRes = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yahooSymbols.join(",")}&fields=regularMarketPrice,regularMarketTime,currency,shortName`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    console.log(`[Yahoo] Status: ${yahooRes.status}`);
    const yahooText = await yahooRes.text();
    console.log(`[Yahoo] Response preview: ${yahooText.substring(0, 100)}`);
    const yahooData = JSON.parse(yahooText);
    results.yahoo = yahooData?.quoteResponse?.result || [];
    console.log(`[Yahoo] Got ${results.yahoo.length} quotes`);
  } catch (e) {
    console.error("[Finansial] Gagal fetch Yahoo Finance:", e.message);
    results.yahoo = [];
  }

  // Format output
  const r = results.kurs || {};
  const idr = r.IDR || 0;
  const getYahoo = (symbol) => results.yahoo.find(q => q.symbol === symbol);

  const ihsg = getYahoo("^JKSE");
  const lq45 = getYahoo("^LQ45.JK");
  const emasUSD = getYahoo("GC=F");
  const antam = getYahoo("ANTM.JK");
  const ptba = getYahoo("PTBA.JK");
  const nikl = getYahoo("NIKL.JK");
  const tins = getYahoo("TINS.JK");
  const simp = getYahoo("SIMP.JK");
  const btc = getYahoo("BTC-USD");
  const eth = getYahoo("ETH-USD");
  const sp500 = getYahoo("^GSPC");
  const nasdaq = getYahoo("^IXIC");
  const dji = getYahoo("^DJI");

  // Hitung emas per gram
  const emasIDRperGram = emasUSD && idr
    ? Math.round((emasUSD.regularMarketPrice * idr) / 31.1035)
    : null;

  const formatIDR = (n) => n ? Math.round(n).toLocaleString('id-ID') : 'tidak tersedia';
  const formatNum = (n, dec=0) => n ? n.toFixed(dec) : 'tidak tersedia';
  const formatUSD = (n, dec=2) => n ? `USD ${n.toFixed(dec)}` : 'tidak tersedia';

  const tanggal = results.kursDate || new Date().toISOString().split('T')[0];

  const finansialText = `
DATA FINANSIAL TERKINI (per ${tanggal}, sumber: ECB & Yahoo Finance):

KURS (terhadap IDR):
- USD 1 = Rp ${formatIDR(idr)}
- SGD 1 = Rp ${formatIDR(idr / (r.SGD || 1))}
- EUR 1 = Rp ${formatIDR(idr / (r.EUR || 1))}
- AUD 1 = Rp ${formatIDR(idr / (r.AUD || 1))}
- CNY 1 = Rp ${formatIDR(idr / (r.CNY || 1))}
- JPY 100 = Rp ${formatIDR((idr / (r.JPY || 1)) * 100)}
- MYR 1 = Rp ${formatIDR(idr / (r.MYR || 1))}

PASAR MODAL INDONESIA:
- IHSG: ${formatNum(ihsg?.regularMarketPrice, 2)}
- LQ45: ${formatNum(lq45?.regularMarketPrice, 2)}

PASAR MODAL US:
- S&P 500: ${formatNum(sp500?.regularMarketPrice, 2)}
- NASDAQ: ${formatNum(nasdaq?.regularMarketPrice, 2)}
- Dow Jones: ${formatNum(dji?.regularMarketPrice, 2)}

EMAS:
- Emas dunia: ${formatUSD(emasUSD?.regularMarketPrice)}/troy oz
- Estimasi emas IDR: Rp ${emasIDRperGram ? formatIDR(emasIDRperGram) : 'tidak tersedia'}/gram
- ANTM (Antam): Rp ${formatIDR(antam?.regularMarketPrice)}/lembar

KRIPTO:
- Bitcoin (BTC): ${formatUSD(btc?.regularMarketPrice)}
- Ethereum (ETH): ${formatUSD(eth?.regularMarketPrice)}

KOMODITAS INDONESIA:
- Batu bara (PTBA): Rp ${formatIDR(ptba?.regularMarketPrice)}/lembar
- Nikel (NIKL): Rp ${formatIDR(nikl?.regularMarketPrice)}/lembar
- Timah (TINS): Rp ${formatIDR(tins?.regularMarketPrice)}/lembar
- Sawit/CPO (SIMP): Rp ${formatIDR(simp?.regularMarketPrice)}/lembar

Catatan: Data ini adalah harga penutupan terakhir, bukan real-time. Untuk data terkini silakan cek di aplikasi broker atau Google Finance.`.trim();

  finansialCache = { data: finansialText, timestamp: now };
  console.log("[Finansial] Data berhasil diupdate");
  return finansialText;
}

// ============================================
// FETCH BERITA TERKINI — RSS Feed Indonesia
// ============================================
let beritaCache = { data: null, timestamp: 0 };

async function fetchBeritaTerkini() {
  const now = Date.now();
  // Cache 2 jam
  if (beritaCache.data && (now - beritaCache.timestamp) < 7200000) {
    return beritaCache.data;
  }

  const beritaList = [];

  // RSS feeds Indonesia — gratis, no API key
  const rssFeeds = [
    { url: "https://rss.kompas.com/money", label: "Kompas Money" },
    { url: "https://www.cnbcindonesia.com/rss", label: "CNBC Indonesia" },
    { url: "https://bisnis.com/rss/ekonomi-bisnis", label: "Bisnis.com" },
  ];

  for (const feed of rssFeeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5000)
      });
      const text = await res.text();
      
      // Parse judul dari RSS XML secara sederhana
      const matches = text.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g) || [];
      
      // Skip judul pertama (nama feed) dan ambil 2 berita
      const titles = matches.slice(1, 3).map(m => {
        return m.replace(/<title><!\[CDATA\[/, '').replace(/\]\]><\/title>/, '')
                .replace(/<title>/, '').replace(/<\/title>/, '').trim();
      }).filter(t => t.length > 10 && t.length < 200);
      
      titles.forEach(t => beritaList.push(`[${feed.label}] ${t}`));
    } catch (e) {
      console.error(`[Berita] Gagal fetch ${feed.label}:`, e.message);
    }
  }

  if (beritaList.length === 0) {
    beritaCache = { data: null, timestamp: now };
    return null;
  }

  const tanggal = new Date().toLocaleDateString('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta'
  });

  const beritaText = `
BERITA EKONOMI TERKINI INDONESIA (per ${tanggal}):
${beritaList.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Gunakan berita ini sebagai konteks saat relevan dengan diskusi klien tentang ekonomi, kebijakan, atau kondisi pasar.`.trim();

  beritaCache = { data: beritaText, timestamp: now };
  console.log(`[Berita] ${beritaList.length} berita berhasil diupdate`);
  return beritaText;
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

    const arrayBuf = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
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
      console.log(`[Chakra] Memproses gambar, media ID: ${mediaId}`);
      const imageBlock = await downloadChakraImage(mediaId, CHAKRA_TOKEN);
      if (imageBlock) {
        console.log(`[Chakra] Gambar berhasil diproses`);
        messageContent.push(imageBlock);
      } else {
        console.log(`[Chakra] Gambar gagal diproses — lanjut tanpa gambar`);
        messageContent.push({ type: "text", text: "Klien mengirimkan gambar tapi tidak bisa dibaca. Minta klien kirim ulang atau deskripsikan isi gambarnya." });
      }
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
    const beritaContext = await fetchBeritaTerkini();
    const fullContext = beritaContext ? `${kursContext}\n\n${beritaContext}` : kursContext;
    const reply = await chat(chatHistory, fullContext);
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
  
  const url = `https://api.chakrahq.com/v1/ext/plugin/whatsapp/${pluginId}/api/v19.0/${phoneNumberId}/messages`;
  
  console.log(`[Chakra] Sending to URL: ${url}`);
  
  const res = await fetch(url, {
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
  
  const rawText = await res.text();
  console.log(`[Chakra] Response status: ${res.status}, body: ${rawText.substring(0, 200)}`);
  
  try {
    const data = JSON.parse(rawText);
    if (!res.ok) console.error("[Chakra] Gagal kirim pesan:", data);
    return data;
  } catch (e) {
    console.error("[Chakra] Response bukan JSON:", rawText);
    return null;
  }
}

// ============================================
// HELPER: Download gambar dari Chakra/Meta
// ============================================
async function downloadChakraImage(mediaId, accessToken) {
  try {
    // Pakai Chakra Show Media API — mediaId sebagai path param
    console.log(`[Image] Fetching media via Chakra Show API, ID: ${mediaId}`);
    const chakraMediaUrl = `https://api.chakrahq.com/v1/whatsapp/v19.0/media/${mediaId}/show`;
    
    const mediaRes = await fetch(chakraMediaUrl, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });

    console.log(`[Image] Chakra media response status: ${mediaRes.status}`);
    
    if (!mediaRes.ok) {
      const errText = await mediaRes.text();
      console.error(`[Image] Chakra media error: ${errText}`);
      return null;
    }

    const arrayBuffer = await mediaRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`[Image] Downloaded ${buffer.length} bytes`);

    // Kompres dengan Sharp — kualitas tinggi untuk keterbacaan dokumen
    const compressed = await sharp(buffer)
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();

    console.log(`[Image] Compressed to ${compressed.length} bytes`);
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
    const beritaContext = await fetchBeritaTerkini();
    const fullContext = beritaContext ? `${kursContext}\n\n${beritaContext}` : kursContext;
    const reply = await chat(messages, fullContext);
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
