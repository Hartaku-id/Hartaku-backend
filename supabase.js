// supabase.js — Supabase database wrapper
// Hartaku Backend v1.4
// Disesuaikan dengan struktur tabel yang sudah ada

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================
// SESSION MANAGEMENT
// ============================================

export async function getOrCreateSession(sessionId, metadata = {}) {
  try {
    // Cari session berdasarkan phone_number
    const { data: existing } = await supabase
      .from("sessions")
      .select("*")
      .eq("phone_number", sessionId)
      .single();

    if (existing) return existing;

    // Buat session baru dengan kolom yang ada
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        id: crypto.randomUUID(),
        phone_number: sessionId,
        platform: metadata.platform || "whatsapp",
      })
      .select()
      .single();

    if (error) throw new Error(`Gagal membuat sesi baru: ${error.message}`);
    return data;
  } catch (err) {
    console.error("[Supabase] getOrCreateSession error:", err);
    throw err;
  }
}

export async function touchSession(sessionId) {
  try {
    await supabase
      .from("sessions")
      .update({ updated_at: new Date().toISOString() })
      .eq("phone_number", sessionId);
  } catch (err) {
    console.error("[Supabase] touchSession error:", err);
  }
}

// ============================================
// MESSAGE MANAGEMENT
// ============================================

export async function getMessages(sessionId) {
  try {
    // Ambil ringkasan jika ada
    const { data: session } = await supabase
      .from("sessions")
      .select("summary")
      .eq("phone_number", sessionId)
      .single();

    // Ambil 20 pesan terakhir
    const { data: messages, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) throw error;

    const result = messages || [];

    // Kalau ada ringkasan, sisipkan sebagai konteks di awal
    if (session?.summary) {
      return [
        {
          role: "user",
          content: `[KONTEKS PERCAKAPAN SEBELUMNYA]\n${session.summary}\n[LANJUTAN PERCAKAPAN]`
        },
        {
          role: "assistant",
          content: "Baik, saya sudah membaca konteks percakapan kita sebelumnya. Silakan lanjutkan."
        },
        ...result
      ];
    }

    return result;
  } catch (err) {
    console.error("[Supabase] getMessages error:", err);
    return [];
  }
}

export async function saveMessage(sessionId, role, content) {
  try {
    const { error } = await supabase.from("messages").insert({
      session_id: sessionId,
      role,
      content,
      created_at: new Date().toISOString(),
    });

    if (error) throw error;

    // Cek jumlah pesan
    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId);

    if (count >= 20) {
      summarizeAndCompress(sessionId).catch(err =>
        console.error("[Supabase] Background summarization error:", err)
      );
    }
  } catch (err) {
    console.error("[Supabase] saveMessage error:", err);
  }
}

// ============================================
// SUMMARIZATION
// ============================================

async function summarizeAndCompress(sessionId) {
  try {
    const { data: allMessages, error } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    if (error || !allMessages || allMessages.length < 20) return;

    console.log(`[Supabase] Mulai summarization sesi ${sessionId} (${allMessages.length} pesan)`);

    const { summarize } = await import("./anthropic.js");

    const conversationText = allMessages
      .map(m => `${m.role === 'user' ? 'Klien' : 'Hartaku'}: ${m.content}`)
      .join('\n');

    const summary = await summarize(conversationText);

    // Simpan ringkasan di sessions berdasarkan phone_number
    await supabase
      .from("sessions")
      .update({ summary })
      .eq("phone_number", sessionId);

    // Sisakan 5 pesan terakhir
    const keepMessages = allMessages.slice(-5);
    const deleteBeforeDate = keepMessages[0].created_at;

    await supabase
      .from("messages")
      .delete()
      .eq("session_id", sessionId)
      .lt("created_at", deleteBeforeDate);

    console.log(`[Supabase] Summarization selesai sesi ${sessionId}`);
  } catch (err) {
    console.error("[Supabase] summarizeAndCompress error:", err);
  }
}

// ============================================
// CLEAR SESSION
// ============================================

export async function clearSession(sessionId) {
  try {
    await supabase.from("messages").delete().eq("session_id", sessionId);
    await supabase
      .from("sessions")
      .update({ summary: null })
      .eq("phone_number", sessionId);
  } catch (err) {
    console.error("[Supabase] clearSession error:", err);
  }
}

export default supabase;
