# HARTAKU BACKEND — PANDUAN DEPLOY

## Prasyarat
- Akun Railway (railway.app)
- Akun GitHub (untuk push kode)
- Supabase sudah siap (URL + Anon Key tersedia)
- Anthropic API Key aktif

---

## LANGKAH 1 — Siapkan Supabase

1. Buka https://supabase.com → pilih project Hartaku
2. Klik **SQL Editor** di sidebar kiri
3. Paste isi file `supabase-schema.sql` → klik **Run**
4. Pastikan tabel `sessions` dan `messages` muncul di **Table Editor**

---

## LANGKAH 2 — Push ke GitHub

```bash
# Di folder hartaku-backend
git init
git add .
git commit -m "Hartaku backend v1.0"

# Buat repo baru di github.com (nama: hartaku-backend, private)
git remote add origin https://github.com/USERNAME/hartaku-backend.git
git push -u origin main
```

---

## LANGKAH 3 — Deploy ke Railway

1. Buka https://railway.app → **New Project**
2. Pilih **Deploy from GitHub repo** → pilih `hartaku-backend`
3. Railway otomatis deteksi Node.js dan build

### Set Environment Variables di Railway:
Klik project → **Variables** → tambahkan satu per satu:

| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | sk-ant-api03-... |
| `SUPABASE_URL` | https://ewwygqtknghptomoopjt.supabase.co |
| `SUPABASE_ANON_KEY` | eyJ... |
| `API_SECRET` | buat random string panjang (contoh: `hartaku-prod-2026-xK9mP...`) |
| `ALLOWED_ORIGINS` | https://hartaku.id (setelah domain aktif) |

4. Railway otomatis redeploy setelah variable di-set
5. Klik **Settings** → catat URL Railway Anda (misal: `https://hartaku-backend.up.railway.app`)

---

## LANGKAH 4 — Update JSX Frontend

Edit file `HartakuFinalOpus46.jsx` — ganti bagian `sendMessage`:

**SEBELUM** (langsung ke Anthropic — API key exposed):
```javascript
const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": "sk-ant-...",  // ← BAHAYA
    ...
  },
  body: JSON.stringify({ model, messages, system: SYSTEM_PROMPT })
});
```

**SESUDAH** (lewat backend — aman):
```javascript
const res = await fetch("https://hartaku-backend.up.railway.app/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-secret": "GANTI_DENGAN_API_SECRET_ANDA",
  },
  body: JSON.stringify({
    message: msg,
    sessionId: sessionId,  // lihat catatan di bawah
  }),
});
const data = await res.json();
const reply = data.reply;
```

### Menambahkan sessionId ke JSX:
```javascript
// Tambahkan state untuk session ID
const [sessionId] = useState(() => {
  // Gunakan yang tersimpan di sessionStorage, atau buat baru
  const saved = sessionStorage.getItem("hartaku_session");
  if (saved) return saved;
  const newId = crypto.randomUUID();
  sessionStorage.setItem("hartaku_session", newId);
  return newId;
});
```

### Update fungsi reset:
```javascript
// Saat tombol Reset diklik, hapus sesi di backend juga
const handleReset = async () => {
  await fetch("https://hartaku-backend.up.railway.app/reset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-secret": "GANTI_DENGAN_API_SECRET_ANDA",
    },
    body: JSON.stringify({ sessionId }),
  });
  // Reset session ID di browser
  const newId = crypto.randomUUID();
  sessionStorage.setItem("hartaku_session", newId);
  setMessages([]);
  setStarted(false);
};
```

---

## LANGKAH 5 — Test End-to-End

```bash
# Test health check
curl https://hartaku-backend.up.railway.app/health

# Test chat (ganti URL dan secret)
curl -X POST https://hartaku-backend.up.railway.app/chat \
  -H "Content-Type: application/json" \
  -H "x-api-secret: API_SECRET_ANDA" \
  -d '{"message": "halo", "sessionId": "test-123"}'
```

Response yang diharapkan:
```json
{
  "reply": "Dengan siapa Hartaku berbicara hari ini?",
  "sessionId": "test-123"
}
```

---

## CATATAN PENTING

- **JANGAN** commit file `.env` ke GitHub
- API_SECRET di frontend JSX sebaiknya disimpan sebagai environment variable juga (jika deploy ke Vercel/Netlify)
- Railway Free tier: 500 jam/bulan — cukup untuk testing
- Supabase Free tier: 500MB database, 50.000 row — cukup untuk ratusan sesi

---

## FASE BERIKUTNYA (Twilio WhatsApp)

Setelah backend berjalan sempurna:
1. Setup Railway webhook URL di Twilio Console
2. Aktifkan route `/twilio/webhook` di `server.js`
3. Parse format Twilio (form-urlencoded) → format Anthropic
4. Balas via Twilio API

---

*Hartaku Backend v1.0 — Confidential & Proprietary 2026*
