/**
 * Bearer access-token verification for holder enrollment (WebCrypto, no JWT library).
 *
 * Only ES256 and RS256 compact JWS are accepted. The token's `iss` must exactly match a
 * configured identity provider; keys come only from that provider's configured JWKS URI
 * (never from the token header). The authenticated subject is `{iss, sub}` of a verified
 * token, never anything the caller supplies in a request body.
 */
import type { SubjectRef } from "@attest/verifier";
import type { IdentityProvider } from "./config";
import { readLimited } from "./limits";

export class TokenError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new TokenError(code);
};

export type JwksFetcher = (uri: string) => Promise<{ keys: JsonWebKey[] }>;
const CLOCK_SKEW_MS = 30_000;
const JWKS_TTL_MS = 300_000;

const decoder = new TextDecoder("utf-8", { fatal: true });
function b64urlBytes(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) fail("invalid_token");
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return fail("invalid_token");
  }
}
function b64urlJson(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(decoder.decode(b64urlBytes(part)));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return fail("invalid_token");
}

export interface JwksFetcherOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
}
export const JWKS_TIMEOUT_MS = 5_000;
export const JWKS_MAX_BYTES = 64 * 1024;
/** Failures are cached briefly so a slow or failing IdP cannot be hammered through enrollment. */
export const JWKS_FAILURE_TTL_MS = 30_000;

export function defaultJwksFetcher(options: JwksFetcherOptions = {}): JwksFetcher {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? JWKS_TIMEOUT_MS, maxBytes = options.maxBytes ?? JWKS_MAX_BYTES;
  const cache = new Map<string, { at: number; keys: JsonWebKey[] } | { at: number; failed: true }>();
  return async (uri) => {
    const hit = cache.get(uri);
    if (hit && "failed" in hit && now() - hit.at < JWKS_FAILURE_TTL_MS) return fail("idp_keys_unavailable");
    if (hit && "keys" in hit && now() - hit.at < JWKS_TTL_MS) return { keys: hit.keys };
    let keys: JsonWebKey[];
    try {
      // "manual": a redirect is a non-200 response and is refused (Workers do not support redirect: "error").
      const res = await doFetch(uri, {
        headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error("status");
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new Error("size");
      const body = JSON.parse(new TextDecoder().decode(await readLimited(res.body, maxBytes))) as { keys?: unknown };
      if (!Array.isArray(body.keys) || body.keys.length > 100) throw new Error("shape");
      keys = body.keys as JsonWebKey[];
    } catch {
      cache.set(uri, { at: now(), failed: true });
      return fail("idp_keys_unavailable");
    }
    cache.set(uri, { at: now(), keys });
    return { keys };
  };
}

async function importVerifyKey(alg: "ES256" | "RS256", jwk: JsonWebKey & { kid?: string; use?: string }): Promise<CryptoKey> {
  if (jwk.use !== undefined && jwk.use !== "sig") fail("idp_key_unusable");
  if (jwk.alg !== undefined && jwk.alg !== alg) fail("idp_key_unusable");
  if ("d" in jwk) fail("idp_key_unusable");
  try {
    if (alg === "ES256") {
      if (jwk.kty !== "EC" || jwk.crv !== "P-256") fail("idp_key_unusable");
      return await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    }
    if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || b64urlBytes(jwk.n).length < 256) fail("idp_key_unusable");
    return await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n!, e: jwk.e! },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch (e) {
    if (e instanceof TokenError) throw e;
    return fail("idp_key_unusable");
  }
}

export interface VerifiedAccessToken { subject: SubjectRef; expiresAt: number }

export async function verifyAccessToken(
  token: string,
  providers: readonly IdentityProvider[],
  fetchJwks: JwksFetcher,
  now: number,
): Promise<VerifiedAccessToken> {
  if (token.length > 16_384) fail("invalid_token");
  const parts = token.split(".");
  if (parts.length !== 3) fail("invalid_token");
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h), claims = b64urlJson(p);
  const alg = header.alg;
  if (alg !== "ES256" && alg !== "RS256") fail("unsupported_token_alg");
  if (header.crit !== undefined) fail("unsupported_token_alg");
  const provider = providers.find((x) => x.issuer === claims.iss);
  if (!provider) fail("untrusted_token_issuer");
  // RFC 9068 access tokens carry typ "at+jwt"; this refuses ID tokens and other JWTs from the same IdP.
  if (typeof header.typ !== "string" || !provider!.allowedTyp.some((t) => t.toLowerCase() === (header.typ as string).toLowerCase()))
    fail("unsupported_token_type");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const { keys } = await fetchJwks(provider!.jwksUri);
  const candidates = (keys as (JsonWebKey & { kid?: string })[]).filter((k) =>
    kid === undefined ? keys.length === 1 : k.kid === kid);
  if (candidates.length !== 1) fail("idp_key_unavailable");
  const key = await importVerifyKey(alg as "ES256" | "RS256", candidates[0]!);
  const signature = b64urlBytes(s);
  const input = new TextEncoder().encode(`${h}.${p}`);
  const valid = alg === "ES256"
    ? signature.length === 64 && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, input)
    : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, input);
  if (!valid) fail("invalid_token_signature");

  const aud = claims.aud;
  if (!(aud === provider!.audience || (Array.isArray(aud) && aud.includes(provider!.audience)))) fail("token_audience_mismatch");
  const seconds = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v * 1000 : undefined);
  const exp = seconds(claims.exp);
  if (exp === undefined || now >= exp) fail("token_expired");
  const nbf = claims.nbf === undefined ? undefined : seconds(claims.nbf) ?? fail("invalid_token");
  if (nbf !== undefined && nbf > now + CLOCK_SKEW_MS) fail("token_not_yet_valid");
  const iat = claims.iat === undefined ? undefined : seconds(claims.iat) ?? fail("invalid_token");
  if (iat !== undefined && iat > now + CLOCK_SKEW_MS) fail("token_not_yet_valid");
  if (provider!.clientId !== undefined) {
    const client = claims.client_id ?? claims.azp;
    if (client !== provider!.clientId) fail("token_client_mismatch");
  }
  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 512 || /[\u0000-\u001f]/.test(sub)) fail("invalid_token_subject");
  return { subject: { issuer: provider!.issuer, subject: sub as string }, expiresAt: exp! };
}
