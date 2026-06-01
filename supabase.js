// supabase.js — Supabase database wrapper
// Hartaku Backend v1.3
// Update: Auto-summarization setelah 20 pesan

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
    const { data: existing } = await supabase
      .from("sessions")
      .select("*")
      .eq("session_id", sessionId)
      .single();

    if (existing) return existing;

    const { data, error } = await supabase
      .from("sessions")
      .insert({
        session_id: sessionId,
        metadata,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`Gagal membuat sesi baru: ${error.message}`);
    return data;
  } catch (err) {
    console.error("[Supabase] getOrCreateSession insert error:", err);
    throw err;
  }
}

export async function touchSession(sessionId) {
  try {
    await supabase
      .from("sessions")
      .update({ updated_at: new Date().toISOString() })
      .eq("session_id", sessionId);
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
      .eq("session_id", sessionId)
      .single();

    // Ambil pesan terbaru (maksimal 20 terakhir)
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

    // Cek jumlah pesan — kalau sudah 20, trigger summarization
    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId);

    if (count >= 20) {
      // Jalankan summarization di background, tidak block respons
      summarizeAndCompress(sessionId).catch(err =>
        console.error("[Supabase] Background summarization error:", err)
      );
    }
  } catch (err) {
    console.error("[Supabase] saveMessage error:", err);
  }
}

// ============================================
// SUMMARIZATION — Claude meringkas percakapan
// ============================================

async function summarizeAndCompress(sessionId) {
  try {
    // Ambil semua pesan yang ada
    const { data: allMessages, error } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    if (error || !allMessages || allMessages.length < 20) return;

    console.log(`[Supabase] Mulai summarization untuk sesi ${sessionId} (${allMessages.length} pesan)`);

    // Import chat function dari anthropic
    const { summarize } = await import("./anthropic.js");

    // Buat ringkasan menggunakan Claude
    const conversationText = allMessages
      .map(m => `${m.role === 'user' ? 'Klien' : 'Hartaku'}: ${m.content}`)
      .join('\n');

    const summary = await summarize(conversationText);

    // Simpan ringkasan di tabel sessions
    await supabase
      .from("sessions")
      .update({
        summary,
        updated_at: new Date().toISOString()
      })
      .eq("session_id", sessionId);

    // Hapus semua pesan lama — sisakan 5 pesan terakhir untuk konteks langsung
    const keepMessages = allMessages.slice(-5);
    const deleteBeforeId = keepMessages[0].created_at;

    await supabase
      .from("messages")
      .delete()
      .eq("session_id", sessionId)
      .lt("created_at", deleteBeforeId);

    console.log(`[Supabase] Summarization selesai untuk sesi ${sessionId}`);
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
      .update({ summary: null, updated_at: new Date().toISOString() })
      .eq("session_id", sessionId);
  } catch (err) {
    console.error("[Supabase] clearSession error:", err);
  }
}

export default supabase;
