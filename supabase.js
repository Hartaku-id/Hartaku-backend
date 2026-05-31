// supabase.js — Supabase client & session helpers
// Hartaku Backend v1.0

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================
// SESSION MANAGEMENT
// ============================================

/**
 * Buat sesi baru atau ambil sesi yang sudah ada
 * @param {string} sessionId - UUID sesi
 * @param {object} metadata - { platform: 'web'|'whatsapp', phoneNumber? }
 */
export async function getOrCreateSession(sessionId, metadata = {}) {
  // Cek apakah sesi sudah ada
  const { data: existing, error: fetchError } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (fetchError && fetchError.code !== "PGRST116") {
    // PGRST116 = not found, error lain perlu dilog
    console.error("[Supabase] getOrCreateSession fetch error:", fetchError);
  }

  if (existing) return existing;

  // Buat sesi baru
  const { data: newSession, error: insertError } = await supabase
    .from("sessions")
    .insert({
      id: sessionId,
      platform: metadata.platform || "web",
      phone_number: metadata.phoneNumber || null,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error("[Supabase] getOrCreateSession insert error:", insertError);
    throw new Error("Gagal membuat sesi baru");
  }

  return newSession;
}

/**
 * Update waktu last_active sesi
 */
export async function touchSession(sessionId) {
  await supabase
    .from("sessions")
    .update({ last_active: new Date().toISOString() })
    .eq("id", sessionId);
}

/**
 * Simpan data profil klien setelah profiling selesai
 * @param {string} sessionId
 * @param {object} profile - { name, gender, age, religion, domisili, ... }
 */
export async function updateSessionProfile(sessionId, profile) {
  const { error } = await supabase
    .from("sessions")
    .update({
      client_name: profile.name || null,
      client_gender: profile.gender || null,
      client_age: profile.age || null,
      last_active: new Date().toISOString(),
    })
    .eq("id", sessionId);

  if (error) console.error("[Supabase] updateSessionProfile error:", error);
}

// ============================================
// MESSAGE HISTORY
// ============================================

/**
 * Ambil seluruh riwayat pesan sesi (untuk dikirim ke Anthropic)
 * @returns {Array} format [{ role: 'user'|'assistant', content: string }]
 */
export async function getMessages(sessionId) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[Supabase] getMessages error:", error);
    return [];
  }

  return data || [];
}

/**
 * Simpan satu pesan ke database
 * @param {string} sessionId
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
export async function saveMessage(sessionId, role, content) {
  const { error } = await supabase.from("messages").insert({
    session_id: sessionId,
    role,
    content,
    created_at: new Date().toISOString(),
  });

  if (error) console.error("[Supabase] saveMessage error:", error);
}

/**
 * Hapus semua pesan sesi (untuk fitur reset)
 */
export async function clearSession(sessionId) {
  await supabase.from("messages").delete().eq("session_id", sessionId);
  await supabase.from("sessions").delete().eq("id", sessionId);
}

export default supabase;
