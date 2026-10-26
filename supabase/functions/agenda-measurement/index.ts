import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
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
      // Fail closed below; never log server-side secrets.
    }
  }
  return "";
}
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = serviceKeyFromEnvironment();
const db = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifierTypes = new Set(["gclid", "gbraid", "wbraid"]);

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply({ message: "Método não permitido." }, 405);
  if (!db) return reply({ message: "A medição ainda não foi configurada no servidor." }, 503);

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return reply({ message: "Solicitação inválida." }, 400); }
  const bookingId = String(body.bookingId || "");
  const accessToken = String(body.accessToken || "");
  if (!uuidPattern.test(bookingId) || accessToken.length < 32 || accessToken.length > 100) {
    return reply({ message: "Reserva não encontrada." }, 404);
  }
  if (body.consent !== true) return reply({ status: "not_recorded" });

  const identifierType = String(body.type || "");
  const identifier = String(body.value || "").trim();
  const hasIdentifier = Boolean(identifierType || identifier);
  if (hasIdentifier && (!identifierTypes.has(identifierType)
    || identifier.length > 512 || !/^[A-Za-z0-9._~+/-]+$/.test(identifier))) {
    return reply({ message: "Identificador de anúncio inválido." }, 400);
  }

  const { error } = await db.rpc("record_ad_measurement_consent", {
    p_appointment_id: bookingId,
    p_access_token_hash: await sha256(accessToken),
    p_identifier_type: hasIdentifier ? identifierType : null,
    p_identifier: hasIdentifier ? identifier : null,
  });
  if (error) {
    if (String(error.message || "").includes("booking_not_found")) return reply({ message: "Reserva não encontrada." }, 404);
    if (String(error.message || "").includes("booking_not_pending")) return reply({ message: "A escolha de medição só pode ser registrada antes da confirmação." }, 409);
    console.error("ad measurement consent request failed", error.code || "unknown");
    return reply({ message: "Não foi possível registrar essa escolha." }, 500);
  }
  return reply({ status: "recorded" });
});
