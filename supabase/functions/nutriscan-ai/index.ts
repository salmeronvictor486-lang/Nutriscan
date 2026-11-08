// NutriScan · Edge Function "nutriscan-ai"
// Única puerta entre la app y la IA. Las claves de API nunca salen de aquí.
//
// Acciones (POST JSON { action, ... } con el JWT del usuario en Authorization):
//   key_status      → ¿tiene el usuario su clave de Claude conectada?
//   save_key        → valida la clave contra Anthropic, la cifra (AES-GCM) y la guarda
//   delete_key      → borra la clave
//   analyze         → foto del plato → alimentos, gramos y nutrientes aproximados
//   lookup          → nutrientes por 100 g de un alimento escrito a mano
//   chat            → asistente NutriScan AI
//   delete_account  → borra fotos, datos y usuario (RGPD)
//
// Secretos necesarios (supabase secrets set ...):
//   NUTRISCAN_KEY_SECRET  → frase larga aleatoria para cifrar las claves de los usuarios
//   FDC_API_KEY           → (opcional) clave gratuita de USDA FoodData Central
//   CLAUDE_MODEL          → (opcional) modelo; por defecto claude-opus-5-5

import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY_SECRET = Deno.env.get("NUTRISCAN_KEY_SECRET") ?? "";
const FDC_API_KEY = Deno.env.get("FDC_API_KEY") ?? "";
const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5-5";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ───────────────────────── Cifrado ─────────────────────────
const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function cryptoKey() {
  if (KEY_SECRET.length < 32) {
    throw new HttpError(500, "server_not_configured", "Falta el secreto NUTRISCAN_KEY_SECRET en el servidor (mín. 32 caracteres).");
  }
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), new TextEncoder().encode(plain));
  return { ciphertext: b64(ct), iv: b64(iv) };
}
async function decrypt(ciphertext: string, iv: string) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await cryptoKey(), unb64(ciphertext));
  return new TextDecoder().decode(pt);
}

// ───────────────────────── Claude ─────────────────────────
async function userClient(userId: string) {
  const { data, error } = await admin.from("ai_credentials").select("key_ciphertext,key_iv").eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(500, "db_error", error.message);
  if (!data) throw new HttpError(412, "no_key", "Conecta tu cuenta de Claude (API key) en Perfil para usar la IA.");
  const apiKey = await decrypt(data.key_ciphertext, data.key_iv);
  return new Anthropic({ apiKey, maxRetries: 2 });
}

function mapAnthropicError(e: unknown): never {
  if (e instanceof Anthropic.AuthenticationError) throw new HttpError(401, "bad_key", "Tu clave de Claude no es válida o fue revocada. Vuelve a conectarla en Perfil.");
  if (e instanceof Anthropic.PermissionDeniedError) throw new HttpError(403, "key_forbidden", "Tu clave no tiene permiso para este modelo.");
  if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "rate_limited", "Has alcanzado el límite de uso de tu clave de Claude. Prueba en un minuto.");
  if (e instanceof Anthropic.BadRequestError) {
    const msg = String((e as Error).message || "");
    if (/credit|billing|balance/i.test(msg)) throw new HttpError(402, "no_credit", "Tu cuenta de la API de Claude no tiene saldo. Añade créditos en console.anthropic.com.");
    throw new HttpError(400, "bad_request", "La IA no pudo procesar la petición. Prueba con otra foto.");
  }
  if (e instanceof Anthropic.APIConnectionError) throw new HttpError(503, "ai_unreachable", "No se pudo contactar con Claude. Reinténtalo.");
  if (e instanceof Anthropic.APIError) throw new HttpError(502, "ai_error", "Claude devolvió un error temporal. Reinténtalo.");
  throw e;
}

type Beta = Anthropic.Beta.Messages.BetaMessage;
function textOf(msg: Beta) {
  if (msg.stop_reason === "refusal") throw new HttpError(422, "refused", "La IA no ha podido responder a esta petición.");
  const t = msg.content.find((b) => b.type === "text");
  if (!t || t.type !== "text") throw new HttpError(502, "empty", "La IA no devolvió respuesta.");
  return t.text;
}

// ───────────────────────── Nutrición ─────────────────────────
type Per100 = { kcal: number; protein: number; carbs: number; fat: number; sat_fat: number; fiber: number; sugar: number; sodium_mg: number };
const nutrientProps = {
  kcal: { type: "number" }, protein: { type: "number" }, carbs: { type: "number" }, fat: { type: "number" },
  sat_fat: { type: "number" }, fiber: { type: "number" }, sugar: { type: "number" }, sodium_mg: { type: "number" },
};
const per100Schema = { type: "object", additionalProperties: false, required: Object.keys(nutrientProps), properties: nutrientProps };

const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_food", "dish_name", "items", "notes"],
  properties: {
    is_food: { type: "boolean" },
    dish_name: { type: "string" },
    notes: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "search_term_en", "grams", "confidence", "per100g"],
        properties: {
          name: { type: "string" },
          search_term_en: { type: "string" },
          grams: { type: "number" },
          confidence: { type: "number" },
          per100g: per100Schema,
        },
      },
    },
  },
};

const ANALYZE_SYSTEM = `Eres el motor de reconocimiento de alimentos de NutriScan.
Analiza la foto de un plato y devuelve SOLO el JSON del esquema.
- Identifica cada alimento distinto visible (separa guarniciones, salsas y bebidas si se ven).
- "name": nombre corto en español, tal como lo diría una persona (p. ej. "Arroz blanco cocido").
- "search_term_en": término genérico en inglés para buscar en USDA FoodData Central (p. ej. "rice white cooked").
- "grams": estimación realista de la porción visible usando como referencia el tamaño del plato, cubiertos y raciones típicas en España. Si hay varias unidades, suma el total.
- "per100g": valores por 100 g del alimento tal como está preparado (cocido, frito, con aceite…). sodium_mg en miligramos, el resto en gramos y kcal.
- "confidence": 0 a 1, tu seguridad en la identificación.
- Si la imagen no muestra comida, is_food=false e items vacío.
- "notes": una frase breve y neutra sobre lo que no se puede saber por la foto (aceite añadido, salsas ocultas, tamaño). Nunca juzgues el plato.
Las cifras son estimaciones; no inventes precisión que una foto no permite.`;

async function fdcLookup(term: string): Promise<Per100 | null> {
  if (!FDC_API_KEY || !term) return null;
  try {
    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("api_key", FDC_API_KEY);
    url.searchParams.set("query", term);
    url.searchParams.set("dataType", "Foundation,SR Legacy");
    url.searchParams.set("pageSize", "1");
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const food = (await r.json())?.foods?.[0];
    if (!food) return null;
    const n: Record<string, number> = {};
    for (const fn of food.foodNutrients ?? []) n[String(fn.nutrientNumber)] = Number(fn.value) || 0;
    const kcal = n["208"] ?? n["958"] ?? n["957"];
    if (kcal == null) return null;
    return {
      kcal, protein: n["203"] ?? 0, carbs: n["205"] ?? 0, fat: n["204"] ?? 0, sat_fat: n["606"] ?? 0,
      fiber: n["291"] ?? 0, sugar: n["269"] ?? n["269.3"] ?? 0, sodium_mg: n["307"] ?? 0,
    };
  } catch {
    return null;
  }
}

const round1 = (x: number) => Math.round((Number(x) || 0) * 10) / 10;
function clean(p: Per100): Per100 {
  const o = {} as Per100;
  for (const k of Object.keys(nutrientProps) as (keyof Per100)[]) o[k] = Math.max(0, round1(p[k]));
  return o;
}

// Prefiere la base de datos USDA; si no hay coincidencia razonable, usa la estimación de la IA.
async function resolveNutrients(term: string, ai: Per100) {
  const db = await fdcLookup(term);
  if (db) {
    const ratio = ai.kcal > 0 ? db.kcal / ai.kcal : 1;
    if (ratio > 0.4 && ratio < 2.5) return { per100g: clean(db), source: "usda" as const };
  }
  return { per100g: clean(ai), source: "ai" as const };
}

async function analyze(client: Anthropic, body: { image_base64?: string; media_type?: string; hint?: string }) {
  const data = body.image_base64 ?? "";
  if (!data || data.length > 7_000_000) throw new HttpError(400, "bad_image", "Imagen vacía o demasiado grande.");
  const media = ["image/jpeg", "image/png", "image/webp"].includes(body.media_type ?? "") ? body.media_type! : "image/jpeg";

  let msg: Beta;
  try {
    msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      // @ts-ignore — parámetro beta: reintenta en otro modelo si hay rechazo
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: ANALYZE_SCHEMA } },
      system: ANALYZE_SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: media as "image/jpeg", data } },
          { type: "text", text: body.hint ? `Contexto del usuario: ${String(body.hint).slice(0, 300)}` : "Analiza este plato." },
        ],
      }],
    });
  } catch (e) { mapAnthropicError(e); }

  const parsed = JSON.parse(textOf(msg!));
  if (!parsed.is_food || !parsed.items?.length) {
    return { is_food: false, items: [], dish_name: "", notes: parsed.notes || "No se han detectado alimentos en la foto." };
  }
  const items = await Promise.all(parsed.items.slice(0, 15).map(async (it: any) => {
    const r = await resolveNutrients(it.search_term_en, it.per100g);
    return {
      name: String(it.name).slice(0, 80),
      grams: Math.max(1, Math.round(Number(it.grams) || 0)),
      confidence: Math.min(1, Math.max(0, Number(it.confidence) || 0)),
      ...r,
    };
  }));
  return { is_food: true, dish_name: parsed.dish_name, notes: parsed.notes, items, model: msg!.model };
}

const LOOKUP_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "search_term_en", "per100g"],
  properties: { name: { type: "string" }, search_term_en: { type: "string" }, per100g: per100Schema },
};

async function lookup(client: Anthropic, body: { name?: string }) {
  const name = String(body.name ?? "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "bad_name", "Escribe el nombre del alimento.");
  let msg: Beta;
  try {
    msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      // @ts-ignore — parámetro beta
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: LOOKUP_SCHEMA } },
      system: "Devuelve los valores nutricionales medios por 100 g del alimento indicado, tal como se consume habitualmente en España. 'name' en español, 'search_term_en' genérico en inglés para USDA FoodData Central. sodium_mg en mg.",
      messages: [{ role: "user", content: name }],
    });
  } catch (e) { mapAnthropicError(e); }
  const p = JSON.parse(textOf(msg!));
  return { name: p.name || name, ...(await resolveNutrients(p.search_term_en, p.per100g)) };
}

const CHAT_SYSTEM = `Eres NutriScan AI, el asistente de nutrición de la app NutriScan ("Eat smart. Live better.").
Tu papel es educativo y cercano:
- Respondes en español, claro y breve (máx. ~180 palabras salvo que pidan detalle). Usa listas cortas cuando ayuden.
- Explicas qué nutrientes aportan los alimentos, propones ideas de comidas equilibradas y variadas, recetas con lo que el usuario tenga.
- Nunca juzgas lo que alguien come: no hay alimentos "buenos" o "malos", ni culpa. No uses lenguaje de "compensar" o "quemar".
- No promueves dietas restrictivas, ayunos extremos, ni déficits agresivos. No das planes de pérdida de peso a menores.
- No diagnosticas ni sustituyes a un profesional; ante patologías, embarazo, medicación o síntomas, recomienda acudir a un dietista-nutricionista o médico.
- Si detectas señales de relación difícil con la comida (miedo a comer, culpa intensa, purgas, restricción severa), responde con calidez y anima a hablar con un profesional sanitario; en una crisis en España, el 024 (línea de atención a la conducta suicida) o el 112.
- Respeta SIEMPRE alergias e intolerancias del perfil: nunca sugieras esos ingredientes.
- Las cifras son aproximadas; dilo cuando des números.`;

async function chat(client: Anthropic, body: { messages?: { role: string; content: string }[]; context?: unknown }) {
  const history = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 4000) }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history[history.length - 1].role !== "user") throw new HttpError(400, "bad_messages", "Mensaje vacío.");

  const ctx = JSON.stringify(body.context ?? {}).slice(0, 4000);
  let msg: Beta;
  try {
    msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      // @ts-ignore — parámetro beta
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        { type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: `Contexto del usuario (perfil y registros de hoy, JSON): ${ctx}` },
      ],
      messages: history,
    });
  } catch (e) { mapAnthropicError(e); }
  return { reply: textOf(msg!) };
}

// ───────────────────────── Router ─────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authErr } = await admin.auth.getUser(jwt);
    if (authErr || !auth?.user) throw new HttpError(401, "unauthorized", "Sesión caducada. Vuelve a iniciar sesión.");
    const uid = auth.user.id;

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "key_status": {
        const { data } = await admin.from("ai_credentials").select("key_hint,updated_at").eq("user_id", uid).maybeSingle();
        return json({ configured: !!data, hint: data?.key_hint ?? null, updated_at: data?.updated_at ?? null, model: MODEL, usda: !!FDC_API_KEY });
      }
      case "save_key": {
        const apiKey = String(body.api_key ?? "").trim();
        if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(apiKey)) throw new HttpError(400, "bad_format", "Eso no parece una API key de Claude (empieza por sk-ant-).");
        try {
          await new Anthropic({ apiKey, maxRetries: 1 }).models.retrieve(MODEL);
        } catch (e) { mapAnthropicError(e); }
        const { ciphertext, iv } = await encrypt(apiKey);
        const hint = `sk-ant-…${apiKey.slice(-4)}`;
        const { error } = await admin.from("ai_credentials").upsert({
          user_id: uid, provider: "anthropic", key_ciphertext: ciphertext, key_iv: iv, key_hint: hint, updated_at: new Date().toISOString(),
        });
        if (error) throw new HttpError(500, "db_error", error.message);
        return json({ configured: true, hint });
      }
      case "delete_key": {
        await admin.from("ai_credentials").delete().eq("user_id", uid);
        return json({ configured: false });
      }
      case "analyze":
        return json(await analyze(await userClient(uid), body));
      case "lookup":
        return json(await lookup(await userClient(uid), body));
      case "chat":
        return json(await chat(await userClient(uid), body));
      case "delete_account": {
        for (let i = 0; i < 50; i++) {
          const { data: files } = await admin.storage.from("meal-photos").list(uid, { limit: 1000 });
          if (!files?.length) break;
          await admin.storage.from("meal-photos").remove(files.map((f) => `${uid}/${f.name}`));
        }
        const { error } = await admin.auth.admin.deleteUser(uid); // cascada: perfil, comidas, agua, clave
        if (error) throw new HttpError(500, "delete_failed", error.message);
        return json({ deleted: true });
      }
      default:
        throw new HttpError(400, "unknown_action", "Acción desconocida.");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ error: "internal", message: "Error interno. Inténtalo de nuevo." }, 500);
  }
});
