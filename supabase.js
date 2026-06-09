// supabase.js — Hartaku Backend
// v1.6 — Daily message limit + auto-summarization

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const DAILY_LIMIT = 60;

// ============================================
// SESSION MANAGEMENT
// ============================================

export async function getOrCreateSession(sessionId, metadata = {}) {
  try {
    const { data: existing } = await supabase
      .from("sessions")
      .select("*")
      .eq("phone_number", sessionId)
      .single();

    if (existing) return existing;

    const { data, error } = await supabase
      .from("sessions")
      .insert({
        id: crypto.randomUUID(),
        phone_number: sessionId,
        platform: metadata.platform || "whatsapp",
        daily_message_count: 0,
        last_message_date: new Date().toISOString().split('T')[0],
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
// DAILY LIMIT CHECK
// ============================================

export async function checkAndIncrementLimit(sessionId) {
  try {
    const { data: session } = await supabase
      .from("sessions")
      .select("daily_message_count, last_message_date")
      .eq("phone_number", sessionId)
      .single();

    if (!session) return { allowed: true, count: 0 };

    const today = new Date().toISOString().split('T')[0];
    const lastDate = session.last_message_date;

    // Reset counter kalau hari baru
    let count = session.daily_message_count || 0;
    if (lastDate !== today) {
      count = 0;
    }

    // Cek limit
    if (count >= DAILY_LIMIT) {
      return { allowed: false, count };
    }

    // Increment counter
    await supabase
      .from("sessions")
      .update({
        daily_message_count: count + 1,
        last_message_date: today,
        updated_at: new Date().toISOString()
      })
      .eq("phone_number", sessionId);

    return { allowed: true, count: count + 1 };
  } catch (err) {
    console.error("[Supabase] checkAndIncrementLimit error:", err);
    return { allowed: true, count: 0 }; // fail open
  }
}

// ============================================
// MESSAGE MANAGEMENT
// ============================================

export async function getMessages(sessionId) {
  try {
    const { data: session } = await supabase
      .from("sessions")
      .select("summary")
      .eq("phone_number", sessionId)
      .single();

    const { data: messages, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) throw error;

    const result = messages || [];

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

    console.log(`[Supabase] Mulai summarization sesi ${sessionId}`);

    const { summarize } = await import("./anthropic.js");

    const conversationText = allMessages
      .map(m => `${m.role === 'user' ? 'Klien' : 'Hartaku'}: ${m.content}`)
      .join('\n');

    const summary = await summarize(conversationText);

    await supabase
      .from("sessions")
      .update({ summary })
      .eq("phone_number", sessionId);

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

// ============================================
// PRICE HISTORY — Simpan & ambil history harga
// ============================================

export async function savePriceHistory(priceData) {
  // priceData: array of { symbol, price, currency, asset_type }
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = priceData.map(d => ({
      date: today,
      asset_type: d.asset_type,
      symbol: d.symbol,
      price: d.price,
      currency: d.currency || 'USD'
    }));

    const { error } = await supabase
      .from('price_history')
      .upsert(rows, { onConflict: 'date,symbol' });

    if (error) throw error;
    console.log(`[Supabase] Price history tersimpan: ${rows.length} data`);
  } catch (err) {
    console.error('[Supabase] savePriceHistory error:', err);
  }
}

export async function getPriceHistory(symbols, days = 7) {
  try {
    const fromDate = new Date(Date.now() - days * 24 * 3600000).toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('price_history')
      .select('date, symbol, price, currency, asset_type')
      .in('symbol', symbols)
      .gte('date', fromDate)
      .order('date', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[Supabase] getPriceHistory error:', err);
    return [];
  }
}

export default supabase;
