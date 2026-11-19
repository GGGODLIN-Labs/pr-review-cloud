import { htmlResponse } from "./page.ts";

const sessionCookie = "__Host-prc_session";
const stateCookie = "__Host-prc_oauth_state";

export interface Env {
  DB?: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BILLING_MODE?: string;
  POLAR_PRO_CHECKOUT_URL?: string;
  POLAR_PRO_PASS_CHECKOUT_URL?: string;
  POLAR_WEBHOOK_SECRET?: string;
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function tokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | undefined {
  return request.headers.get("Cookie")?.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function redirect(location: string, status = 303, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status, headers });
}

export function startLogin(env: Env, origin: string): Response {
  if (!env.GITHUB_CLIENT_ID) return htmlResponse("暫時無法登入", "<p>尚未設定 GitHub 登入。</p>", 503);
  const state = randomToken();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${origin}/auth/github/callback`,
    state,
    scope: "read:user",
  });
  return redirect(`https://github.com/login/oauth/authorize?${params}`, 302, [cookie(stateCookie, state, 600)]);
}

export async function completeLogin(request: Request, env: Env, origin: string): Promise<Response> {
  const clearState = cookie(stateCookie, "", 0);
  const fail = (title: string, message: string, status: number) => {
    const response = htmlResponse(title, `<p>${message}</p><a href="/auth/github">重新登入</a>`, status);
    response.headers.append("Set-Cookie", clearState);
    return response;
  };
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  if (!state || state !== readCookie(request, stateCookie)) {
    return fail("GitHub 登入失敗", "OAuth state 缺少或不符。", 400);
  }
  const code = query.get("code");
  if (!code) return fail("GitHub 登入失敗", "GitHub 未提供授權碼。", 400);
  const db = env.DB;
  if (!db || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return fail("GitHub 登入失敗", "尚未設定 GitHub 登入。", 503);
  }

  let profile: { id?: unknown; login?: unknown; avatar_url?: unknown } | null;
  try {
    const exchange = await globalThis.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${origin}/auth/github/callback`,
      }),
    });
    const token = exchange.ok ? (await exchange.json<{ access_token?: unknown }>())?.access_token : undefined;
    if (typeof token !== "string" || !token) throw new Error("GitHub did not issue a token");
    const identity = await globalThis.fetch("https://api.github.com/user", {
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "PR-Review-Cloud" },
    });
    profile = identity.ok ? await identity.json() : null;
  } catch {
    profile = null;
  }
  if (typeof profile?.id !== "number" || !Number.isSafeInteger(profile.id) || profile.id <= 0 ||
      typeof profile.login !== "string" || !profile.login) {
    return fail("GitHub 登入失敗", "無法向 GitHub 取得有效的使用者身分。", 502);
  }

  const user = await db.prepare(`
    INSERT INTO users (id, github_id, github_login, avatar_url) VALUES (?, ?, ?, ?)
    ON CONFLICT (github_id) DO UPDATE SET github_login = excluded.github_login,
      avatar_url = excluded.avatar_url, updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `).bind(crypto.randomUUID(), String(profile.id), profile.login,
    typeof profile.avatar_url === "string" ? profile.avatar_url : null).first<{ id: string }>();
  if (!user) return fail("GitHub 登入失敗", "無法建立使用者工作階段。", 503);
  const token = randomToken();
  const hash = await tokenHash(token);
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= CURRENT_TIMESTAMP")
    .bind(user.id).run();
  await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .bind(hash, user.id).run();
  return redirect("/workspace", 302, [clearState, cookie(sessionCookie, token, 30 * 24 * 60 * 60)]);
}

export interface SignedInUser {
  id: string;
  github_login: string;
  plan: string;
  avatar_url: string | null;
}

export async function signedInUser(request: Request, db: D1Database): Promise<SignedInUser | null> {
  const token = readCookie(request, sessionCookie);
  if (!token) return null;
  return db.prepare(`
    SELECT users.id, users.github_login, users.plan, users.avatar_url FROM sessions JOIN users ON sessions.user_id = users.id
    WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP
  `).bind(await tokenHash(token)).first<SignedInUser>();
}

export async function logout(request: Request, db: D1Database): Promise<Response> {
  const token = readCookie(request, sessionCookie);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await tokenHash(token)).run();
  return redirect("/", 302, [cookie(sessionCookie, "", 0)]);
}

export async function apiKeyOwner(request: Request, db: D1Database): Promise<{ id: string } | null> {
  const key = request.headers.get("Authorization")?.match(/^Bearer (prc_[A-Za-z0-9_-]+)$/i)?.[1];
  if (!key) return null;
  return db.prepare("SELECT user_id AS id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await tokenHash(key)).first();
}
