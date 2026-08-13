// ─────────────────────────────────────────────────────────────────────────
// Edge Function: login  (Phase 0 of RLS hardening)
//
// Verifies staff credentials against app_users using the SERVICE ROLE, so the
// browser never reads password_hash / password_salt. Returns a safe profile
// plus a signed session token (HS256, HMAC over SESSION_JWT_SECRET) that the
// admin-users function checks for privileged operations.
//
// Deploy:  supabase functions deploy login
// Secrets: SESSION_JWT_SECRET (long random). SUPABASE_URL and
//          SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// This function is PUBLIC (it takes credentials); it must be callable with the
// anon key. It performs its own credential check — the anon key grants nothing.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_SECRET = Deno.env.get("SESSION_JWT_SECRET")!;
const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 days — matches AUTH_TTL_MS in app.js

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function sha256Hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

// Sign a compact JWT (HS256). Kept dependency-free via Web Crypto.
async function signSession(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...claims, iat: now, exp: now + SESSION_TTL_S };
  const data = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return `${data}.${b64url(sig)}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { username, password } = await req.json().catch(() => ({}));
    const u = (username ?? "").toString().trim();
    if (!u || !password) return json({ error: "Enter your username and password." }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data: rows } = await admin
      .from("app_users")
      .select("id, username, display_name, role, is_active, password_salt, password_hash")
      .eq("username", u)
      .eq("is_active", true)
      .limit(1);

    const user = rows?.[0];
    // Always compute a hash (even when the user is missing) to flatten the
    // timing difference between "no such user" and "wrong password".
    const salt = user?.password_salt ?? "";
    const hash = await sha256Hex(salt + password);
    if (!user || hash !== user.password_hash) {
      return json({ error: "Incorrect username or password." }, 401);
    }

    // Best-effort last-login stamp; awaited so it actually runs before the
    // isolate returns, but a failure here never blocks the login result.
    try {
      await admin.from("app_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
    } catch (_e) { /* ignore — stamping last_login is non-critical */ }

    const profile = {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      role: user.role || "staff",
    };
    const token = await signSession({ sub: user.id, username: user.username, role: profile.role });
    return json({ user: profile, token }, 200);
  } catch (_e) {
    return json({ error: "Login failed." }, 500);
  }
});
