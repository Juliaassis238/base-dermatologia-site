import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_EMAIL = "contato@basedermatologia.com.br";
const WHATSAPP_NUMBER = "5511927420834";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

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
      // Fail closed without logging environment values.
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

async function authenticateAdmin(request: Request): Promise<boolean> {
  if (!db) return false;
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length < 40) return false;
  const { data, error } = await db.auth.getUser(token);
  return !error && data.user?.email?.trim().toLowerCase() === ADMIN_EMAIL;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!db) return reply({ message: "O ambiente de teste não está configurado." }, 503);
  if (!await authenticateAdmin(request)) return reply({ message: "Acesso não autorizado." }, 401);

  const url = new URL(request.url);
  if (request.method === "GET") {
    const testDate = url.searchParams.get("date") || "";
    if (!isDateOnly(testDate)) return reply({ message: "Informe uma data válida para os testes." }, 400);
    const { data, error } = await db
      .from("agenda_test_entries")
      .select("id,test_name,doctor_name,test_date,amount_cents,status,created_at,updated_at")
      .eq("is_test", true)
      .eq("test_date", testDate)
      .order("test_name", { ascending: true })
      .limit(10);
    if (error) {
      console.error("agenda test list failed", error.code || "unknown");
      return reply({ message: "Não foi possível carregar os registros de teste." }, 500);
    }
    return reply({ testEntries: data || [], whatsappNumber: WHATSAPP_NUMBER });
  }

  if (request.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return reply({ message: "Não foi possível ler a alteração do teste." }, 400); }
    const testEntryId = String(body.testEntryId || "");
    const action = String(body.action || "");
    if (!uuidPattern.test(testEntryId)) return reply({ message: "Código de teste inválido." }, 400);
    const transitions: Record<string, { from: string[]; to: string; message: string }> = {
      mark_proof_received: { from: ["pending_payment"], to: "payment_review", message: "Comprovante de teste registrado. Confira o crédito real de R$ 0,01 antes de liberar." },
      approve: { from: ["payment_review"], to: "confirmed", message: "Teste liberado. Nenhum horário ou agendamento real foi criado." },
      cancel: { from: ["pending_payment", "payment_review"], to: "cancelled", message: "Registro de teste cancelado; nenhuma vaga real foi afetada." },
      reset: { from: ["confirmed", "cancelled"], to: "pending_payment", message: "Teste reiniciado para começar novamente pelo Pix." },
    };
    const transition = transitions[action];
    if (!transition) return reply({ message: "Ação de teste inválida." }, 400);
    const { data, error } = await db
      .from("agenda_test_entries")
      .update({ status: transition.to, updated_at: new Date().toISOString() })
      .eq("id", testEntryId)
      .eq("is_test", true)
      .in("status", transition.from)
      .select("id,test_name,status")
      .maybeSingle();
    if (error) {
      console.error("agenda test update failed", error.code || "unknown");
      return reply({ message: "Não foi possível atualizar o registro de teste." }, 500);
    }
    if (!data) return reply({ message: "O teste não foi encontrado ou já mudou de situação." }, 409);
    return reply({ testEntry: data, message: transition.message });
  }

  return reply({ message: "Rota de teste não encontrada." }, 404);
});
