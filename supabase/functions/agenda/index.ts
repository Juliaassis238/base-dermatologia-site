import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function serviceKeyFromEnvironment(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (typeof parsed.default === "string") return parsed.default;
      if (typeof parsed.service_role === "string") return parsed.service_role;
    } catch {
      // Fail closed below; never log secret environment values.
    }
  }
  return "";
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = serviceKeyFromEnvironment();
const db = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePhone(value: string): string {
  return value.replace(/[^0-9+]/g, "").trim();
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!db) return reply({ message: "A agenda ainda não foi configurada no servidor." }, 503);

  const url = new URL(request.url);
  const route = url.pathname.split("/").filter(Boolean).at(-1) || "";

  if (route === "health" && request.method === "GET") return reply({ status: "ok" });

  if (route === "availability" && request.method === "GET") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    if (!dateOnlyPattern.test(from) || !dateOnlyPattern.test(to) || from > to) {
      return reply({ message: "Informe um período válido para consultar os horários." }, 400);
    }
    const start = new Date(`${from}T00:00:00-03:00`);
    const end = new Date(`${to}T23:59:59.999-03:00`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() - start.getTime() > 32 * 24 * 60 * 60 * 1000) {
      return reply({ message: "O período solicitado não é válido." }, 400);
    }

    const { data, error } = await db
      .from("availability_slots")
      .select("id, doctor_id, starts_at, ends_at, doctors!inner(display_name, is_active)")
      .eq("status", "available")
      .eq("doctors.is_active", true)
      .gt("starts_at", new Date().toISOString())
      .gte("starts_at", start.toISOString())
      .lte("starts_at", end.toISOString())
      .order("starts_at", { ascending: true })
      .limit(200);

    if (error) {
      console.error("agenda availability query failed", error.code || "unknown");
      return reply({ message: "Não foi possível consultar os horários agora." }, 500);
    }

    const slots = (data || []).map((slot: Record<string, unknown>) => {
      const relatedDoctor = slot.doctors as { display_name?: string } | { display_name?: string }[] | null;
      const doctor = Array.isArray(relatedDoctor) ? relatedDoctor[0] : relatedDoctor;
      return {
        id: slot.id,
        doctorId: slot.doctor_id,
        doctorName: doctor?.display_name || "Equipe Base Dermatologia",
        startsAt: slot.starts_at,
        endsAt: slot.ends_at,
        status: "available",
      };
    });
    return reply({ slots });
  }

  if (route === "book-appointment" && request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return reply({ message: "Não foi possível ler os dados enviados." }, 400);
    }

    const slotId = String(body.slotId || "");
    const fullName = String(body.fullName || "").trim();
    const phone = normalizePhone(String(body.phone || ""));
    const email = String(body.email || "").trim().toLowerCase();
    const privacyVersion = String(body.privacyVersion || "").trim();
    const acceptedPrivacy = body.acceptedPrivacy === true;
    const honeypot = String(body.website || "").trim();
    const phoneDigits = phone.replace(/\D/g, "");

    if (honeypot) return reply({ message: "Não foi possível enviar a solicitação." }, 400);
    if (!uuidPattern.test(slotId)
      || fullName.length < 2 || fullName.length > 120
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
      || phoneDigits.length < 10 || phoneDigits.length > 13
      || !acceptedPrivacy || !privacyVersion || privacyVersion.length > 80) {
      return reply({ message: "Confira seu nome, telefone, e-mail e a leitura do aviso de privacidade." }, 400);
    }

    const accessToken = randomAccessToken();
    const accessTokenHash = await sha256(accessToken);
    const { data: bookingId, error } = await db.rpc("book_appointment_without_payment", {
      p_slot_id: slotId,
      p_patient_name: fullName,
      p_patient_email: email,
      p_patient_phone: phone,
      p_access_token_hash: accessTokenHash,
      p_privacy_notice_version: privacyVersion,
    });

    if (error) {
      const message = String(error.message || "");
      if (message.includes("slot_unavailable") || message.includes("slot_not_found")) {
        return reply({ message: "Esse horário acabou de ficar indisponível. Atualize a agenda e escolha outro." }, 409);
      }
      if (message.includes("doctor_inactive")) {
        return reply({ message: "A agenda dessa profissional está temporariamente fechada." }, 409);
      }
      if (message.includes("invalid_booking_input")) {
        return reply({ message: "Confira os dados e tente novamente." }, 400);
      }
      console.error("agenda booking failed", error.code || "unknown");
      return reply({ message: "Não foi possível confirmar agora. Tente novamente ou fale com a clínica." }, 500);
    }

    return reply({
      bookingId,
      accessToken,
      status: "confirmed",
      paymentRequired: false,
    }, 201);
  }

  if (route === "booking-status" && request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return reply({ message: "Não foi possível consultar a reserva." }, 400);
    }
    const bookingId = String(body.bookingId || "");
    const accessToken = String(body.accessToken || "");
    if (!uuidPattern.test(bookingId) || accessToken.length < 32 || accessToken.length > 100) {
      return reply({ message: "Reserva não encontrada." }, 404);
    }

    const { data, error } = await db
      .from("appointments")
      .select("status, confirmed_at, slot:availability_slots(starts_at, ends_at), doctor:doctors(display_name)")
      .eq("id", bookingId)
      .eq("access_token_hash", await sha256(accessToken))
      .maybeSingle();
    if (error) {
      console.error("agenda status query failed", error.code || "unknown");
      return reply({ message: "Não foi possível consultar a reserva agora." }, 500);
    }
    if (!data) return reply({ message: "Reserva não encontrada." }, 404);

    const slot = data.slot as { starts_at?: string; ends_at?: string } | null;
    const doctor = data.doctor as { display_name?: string } | null;
    return reply({
      status: data.status,
      confirmedAt: data.confirmed_at,
      startsAt: slot?.starts_at,
      endsAt: slot?.ends_at,
      doctorName: doctor?.display_name,
      paymentRequired: false,
    });
  }

  return reply({ message: "Rota não encontrada." }, 404);
});
