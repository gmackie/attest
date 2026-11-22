/**
 * CORS for browser wallets (ATTE-20: the attest.gmac.io vendor portal presents from the browser).
 *
 * Only exact origins from a configured allowlist get CORS headers; no credentials (cookies) are
 * ever allowed, since every authenticated call carries an explicit bearer token. A missing or
 * malformed allowlist means no cross-origin access, never "any origin".
 */
const ALLOW_HEADERS = "authorization, content-type";

export function parseOrigins(raw: unknown): Set<string> {
  if (typeof raw !== "string" || !raw) return new Set();
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(list)) return new Set();
  const origins = new Set<string>();
  for (const o of list) {
    if (typeof o !== "string") continue;
    try {
      const u = new URL(o);
      const local = u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      if ((u.protocol === "https:" || local) && u.origin === o) origins.add(o);
    } catch {
      /* ignored */
    }
  }
  return origins;
}

/** Wraps a handler: answers preflights for allowed origins and decorates their responses. */
export function withCors<E>(allowed: (env: E) => Set<string>, methods: string,
  handler: (request: Request, env: E) => Promise<Response>) {
  return async (request: Request, env: E): Promise<Response> => {
    const origin = request.headers.get("origin");
    const ok = origin !== null && allowed(env).has(origin);
    if (request.method === "OPTIONS" && origin !== null) {
      if (!ok) return new Response(null, { status: 403, headers: { vary: "Origin" } });
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": origin, "access-control-allow-methods": methods,
        "access-control-allow-headers": ALLOW_HEADERS, "access-control-max-age": "600", vary: "Origin",
      } });
    }
    const response = await handler(request, env);
    if (!ok) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
