import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const ADMIN_EMAIL = "contato@basedermatologia.com.br";
const DEPOSIT_AMOUNT_CENTS = 12500;
const WHATSAPP_NUMBER = "5511927420834";
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const adminEditFields = new Set([
  "patient_name", "patient_email", "patient_phone", "patient_cpf",
  "patient_address_line", "patient_address_number", "patient_address_complement",
  "patient_address_neighborhood", "patient_address_city", "patient_address_state",
  "patient_address_postal_code", "new_slot_id",
]);

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

function isDateOnly(value: string): boolean {
  if (!dateOnlyPattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

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

function digitsOnly(value: unknown): string {
  return String(value || "").replace(/\D/g, "");
}

function isValidCpf(value: string): boolean {
  const cpf = digitsOnly(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const checkDigit = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const digit = (sum * 10) % 11;
    return digit === 10 ? 0 : digit;
  };
  return checkDigit(9) === Number(cpf[9]) && checkDigit(10) === Number(cpf[10]);
}

async function authenticateAdmin(request: Request): Promise<{ email: string } | null> {
  if (!db) return null;
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length < 40) return null;
  const { data, error } = await db.auth.getUser(token);
  const email = data.user?.email?.trim().toLowerCase() || "";
  if (error || email !== ADMIN_EMAIL) return null;
  return { email };
}

function dbError(error: { message?: string; code?: string } | null, fallback: string, status = 500) {
  const message = String(error?.message || "");
  if (message.includes("slot_unavailable") || message.includes("new_slot_unavailable") || message.includes("appointment_slot_unavailable")) {
    return reply({ message: "Esse horário não está mais disponível. Atualize a agenda e escolha outro." }, 409);
  }
  if (message.includes("appointment_not_approvable") || message.includes("appointment_not_reschedulable") || message.includes("booking_not_pending")) {
    return reply({ message: "Essa reserva não permite essa alteração no estado atual." }, 409);
  }
  if (message.includes("booking_not_found") || message.includes("appointment_not_found") || message.includes("slot_not_found")) {
    return reply({ message: "Reserva não encontrada." }, 404);
  }
  if (message.includes("doctor_inactive")) return reply({ message: "A agenda dessa profissional está temporariamente fechada." }, 409);
  if (message.includes("invalid_booking_input") || message.includes("invalid_changes") || message.includes("invalid_patient_") || message.includes("invalid_slot_id")) {
    return reply({ message: "Confira os dados informados e tente novamente." }, 400);
  }
  if (message.includes("payment_window_expired")) return reply({ message: "O prazo para pagamento expirou. Escolha novamente um horário disponível." }, 409);
  console.error("agenda request failed", error?.code || "unknown");
  return reply({ message: fallback }, status);
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
    if (!isDateOnly(from) || !isDateOnly(to) || from > to) {
      return reply({ message: "Informe um período válido para consultar os horários." }, 400);
    }
    const start = new Date(`${from}T00:00:00-03:00`);
    const end = new Date(`${to}T23:59:59.999-03:00`);
    if (end.getTime() - start.getTime() > 32 * 24 * 60 * 60 * 1000) {
      return reply({ message: "O período solicitado não é válido." }, 400);
    }
    const { error: expiryError } = await db.rpc("expire_pending_pix_appointments");
    if (expiryError) return dbError(expiryError, "Não foi possível atualizar a disponibilidade agora.");
    const { error: generationError } = await db.rpc("generate_recurring_slots", {
      p_from_date: from,
      p_to_date: to,
    });
    if (generationError) {
      console.error("agenda slot generation failed", generationError.code || "unknown");
      return reply({ message: "Não foi possível preparar os horários agora." }, 500);
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
      return reply({ message: "Não foi possível consultar a agenda." }, 500);
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
    try { body = await request.json(); } catch { return reply({ message: "Não foi possível ler os dados enviados." }, 400); }
    const slotId = String(body.slotId || "");
    const fullName = String(body.fullName || "").trim();
    const phone = normalizePhone(String(body.phone || ""));
    const email = String(body.email || "").trim().toLowerCase();
    const cpf = digitsOnly(body.cpf);
    const address = body.address && typeof body.address === "object" ? body.address as Record<string, unknown> : {};
    const addressLine = String(address.line || "").trim();
    const addressNumber = String(address.number || "").trim();
    const addressComplement = String(address.complement || "").trim();
    const addressNeighborhood = String(address.neighborhood || "").trim();
    const addressCity = String(address.city || "").trim();
    const addressState = String(address.state || "").trim().toUpperCase();
    const addressPostalCode = digitsOnly(address.postalCode);
    const privacyVersion = String(body.privacyVersion || "").trim();
    const acceptedPrivacy = body.acceptedPrivacy === true;
    const honeypot = String(body.website || "").trim();
    const phoneDigits = phone.replace(/\D/g, "");
    if (honeypot) return reply({ message: "Não foi possível enviar a solicitação." }, 400);
    if (!uuidPattern.test(slotId)
      || fullName.length < 2 || fullName.length > 120
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
      || phoneDigits.length < 10 || phoneDigits.length > 13
      || !isValidCpf(cpf)
      || addressLine.length < 2 || addressLine.length > 160
      || addressNumber.length < 1 || addressNumber.length > 20
      || addressComplement.length > 100
      || addressNeighborhood.length < 2 || addressNeighborhood.length > 80
      || addressCity.length < 2 || addressCity.length > 80
      || !/^[A-Z]{2}$/.test(addressState)
      || !/^\d{8}$/.test(addressPostalCode)
      || !acceptedPrivacy || !privacyVersion || privacyVersion.length > 80) {
      return reply({ message: "Confira nome, contato, CPF, endereço completo e o aviso de privacidade." }, 400);
    }
    const accessToken = randomAccessToken();
    const { data: bookingId, error } = await db.rpc("book_appointment_for_pix", {
      p_slot_id: slotId,
      p_patient_name: fullName,
      p_patient_email: email,
      p_patient_phone: phone,
      p_patient_cpf: cpf,
      p_patient_address_line: addressLine,
      p_patient_address_number: addressNumber,
      p_patient_address_complement: addressComplement || null,
      p_patient_address_neighborhood: addressNeighborhood,
      p_patient_address_city: addressCity,
      p_patient_address_state: addressState,
      p_patient_address_postal_code: addressPostalCode,
      p_access_token_hash: await sha256(accessToken),
      p_privacy_notice_version: privacyVersion,
    });
    if (error) return dbError(error, "Não foi possível iniciar a reserva. Tente novamente ou fale com a clínica.");
    const { data: record, error: readError } = await db
      .from("appointments")
      .select("id, status, payment_required, payment_status, deposit_amount_cents, hold_expires_at, slot:availability_slots!appointments_slot_id_fkey(starts_at, ends_at), doctor:doctors!appointments_doctor_id_fkey(display_name)")
      .eq("id", bookingId)
      .single();
    if (readError || !record) return dbError(readError, "A reserva foi criada, mas não conseguimos carregar os detalhes de pagamento.");
    const relatedSlot = record.slot as { starts_at?: string; ends_at?: string } | { starts_at?: string; ends_at?: string }[] | null;
    const slot = Array.isArray(relatedSlot) ? relatedSlot[0] : relatedSlot;
    const relatedDoctor = record.doctor as { display_name?: string } | { display_name?: string }[] | null;
    const doctor = Array.isArray(relatedDoctor) ? relatedDoctor[0] : relatedDoctor;
    return reply({
      bookingId: record.id,
      accessToken,
      status: record.status,
      paymentRequired: record.payment_required,
      paymentStatus: record.payment_status,
      amountCents: record.deposit_amount_cents,
      holdExpiresAt: record.hold_expires_at,
      doctorName: doctor?.display_name || "Equipe Base Dermatologia",
      startsAt: slot?.starts_at,
      endsAt: slot?.ends_at,
      whatsappNumber: WHATSAPP_NUMBER,
    }, 201);
  }

  if (route === "mark-proof-sent" && request.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return reply({ message: "Não foi possível registrar o envio do comprovante." }, 400); }
    const bookingId = String(body.bookingId || "");
    const accessToken = String(body.accessToken || "");
    if (!uuidPattern.test(bookingId) || accessToken.length < 32 || accessToken.length > 100) {
      return reply({ message: "Reserva não encontrada." }, 404);
    }
    const { error } = await db.rpc("mark_pix_proof_sent", {
      p_appointment_id: bookingId,
      p_access_token_hash: await sha256(accessToken),
    });
    if (error) return dbError(error, "Não foi possível atualizar essa reserva.");
    return reply({ status: "payment_review", message: "Envio registrado. A consulta só será confirmada depois que a clínica conferir o Pix." });
  }

  if (route === "booking-status" && request.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return reply({ message: "Não foi possível consultar a reserva." }, 400); }
    const bookingId = String(body.bookingId || "");
    const accessToken = String(body.accessToken || "");
    if (!uuidPattern.test(bookingId) || accessToken.length < 32 || accessToken.length > 100) return reply({ message: "Reserva não encontrada." }, 404);
    const { data, error } = await db
      .from("appointments")
      .select("status, payment_status, payment_required, confirmed_at, hold_expires_at, slot:availability_slots!appointments_slot_id_fkey(starts_at, ends_at), doctor:doctors!appointments_doctor_id_fkey(display_name)")
      .eq("id", bookingId)
      .eq("access_token_hash", await sha256(accessToken))
      .maybeSingle();
    if (error) return dbError(error, "Não foi possível consultar a reserva agora.");
    if (!data) return reply({ message: "Reserva não encontrada." }, 404);
    const relatedSlot = data.slot as { starts_at?: string; ends_at?: string } | { starts_at?: string; ends_at?: string }[] | null;
    const slot = Array.isArray(relatedSlot) ? relatedSlot[0] : relatedSlot;
    const relatedDoctor = data.doctor as { display_name?: string } | { display_name?: string }[] | null;
    const doctor = Array.isArray(relatedDoctor) ? relatedDoctor[0] : relatedDoctor;
    return reply({
      status: data.status,
      paymentStatus: data.payment_status,
      paymentRequired: data.payment_required,
      confirmedAt: data.confirmed_at,
      holdExpiresAt: data.hold_expires_at,
      startsAt: slot?.starts_at,
      endsAt: slot?.ends_at,
      doctorName: doctor?.display_name,
    });
  }

  if (route === "admin-appointments" && request.method === "GET") {
    const admin = await authenticateAdmin(request);
    if (!admin) return reply({ message: "Acesso não autorizado." }, 401);
    const status = url.searchParams.get("status") || "";
    const allowedStatuses = new Set(["pending_payment", "payment_review", "confirmed", "cancelled", "expired"]);
    if (status && !allowedStatuses.has(status)) return reply({ message: "Filtro de situação inválido." }, 400);
    const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
    const search = String(url.searchParams.get("q") || "").trim().slice(0, 100);
    const { data, error } = await db.rpc("admin_search_appointments", {
      p_status: status || null,
      p_search: search,
      p_offset: (page - 1) * 50,
      p_limit: 50,
    });
    if (error) return dbError(error, "Não foi possível carregar os agendamentos.");
    return reply({ appointments: data || [], page, pageSize: 50, hasMore: (data || []).length === 50 });
  }

  if (route === "admin-appointment" && request.method === "POST") {
    const admin = await authenticateAdmin(request);
    if (!admin) return reply({ message: "Acesso não autorizado." }, 401);
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return reply({ message: "Não foi possível ler a alteração." }, 400); }
    const appointmentId = String(body.appointmentId || "");
    const action = String(body.action || "");
    if (!uuidPattern.test(appointmentId)) return reply({ message: "Código de agendamento inválido." }, 400);
    if (action === "approve") {
      const { error } = await db.rpc("admin_approve_pix_appointment", { p_appointment_id: appointmentId, p_actor_email: admin.email });
      if (error) return dbError(error, "Não foi possível liberar essa marcação.");
      return reply({ status: "confirmed", message: "Pix registrado e marcação liberada." });
    }
    if (action === "cancel") {
      const { error } = await db.rpc("admin_cancel_appointment", { p_appointment_id: appointmentId, p_actor_email: admin.email });
      if (error) return dbError(error, "Não foi possível cancelar essa marcação.");
      return reply({ status: "cancelled", message: "Marcação cancelada." });
    }
    if (action === "edit") {
      const changes = body.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) return reply({ message: "Informe os campos válidos para editar." }, 400);
      if (Object.keys(changes).some((key) => !adminEditFields.has(key))) return reply({ message: "A edição contém um campo não permitido." }, 400);
      const { error } = await db.rpc("admin_update_appointment", {
        p_appointment_id: appointmentId,
        p_actor_email: admin.email,
        p_changes: changes,
      });
      if (error) return dbError(error, "Não foi possível salvar as alterações.");
      return reply({ status: "updated", message: "Alterações salvas." });
    }
    return reply({ message: "Ação administrativa inválida." }, 400);
  }

  return reply({ message: "Rota não encontrada." }, 404);
});
