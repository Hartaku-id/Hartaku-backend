-- ============================================
-- HARTAKU — SUPABASE SCHEMA
-- Jalankan di Supabase SQL Editor
-- ============================================

-- Tabel sesi klien
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,          -- UUID dari frontend
  platform      TEXT NOT NULL DEFAULT 'web', -- 'web' | 'whatsapp'
  phone_number  TEXT,                       -- untuk WhatsApp (Fase 2)
  client_name   TEXT,                       -- diisi setelah profiling
  client_gender TEXT,                       -- 'pria' | 'wanita'
  client_age    INTEGER,                    -- usia klien
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabel riwayat pesan
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index untuk query cepat per sesi
CREATE INDEX IF NOT EXISTS idx_messages_session_id
  ON messages (session_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_sessions_last_active
  ON sessions (last_active DESC);

-- ============================================
-- ROW LEVEL SECURITY (opsional tapi disarankan)
-- Aktifkan jika menggunakan Supabase Auth
-- ============================================
-- ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
