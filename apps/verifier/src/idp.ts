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

export function defaultJwksFetcher(): JwksFetcher {
  const cache = new Map<string, { at: number; keys: JsonWebKey[] }>();
  return async (uri) => {
    const hit = cache.get(uri);
    if (hit && Date.now() - hit.at < JWKS_TTL_MS) return { keys: hit.keys };
    let body: { keys?: unknown };
    try {
      // "manual": a redirect is a non-2xx response and is refused (Workers do not support redirect: "error").
      const res = await fetch(uri, { headers: { accept: "application/json" }, redirect: "manual" });
      if (res.status !== 200) return fail("idp_keys_unavailable");
      body = (await res.json()) as { keys?: unknown };
    } catch (e) {
      if (e instanceof TokenError) throw e;
      return fail("idp_keys_unavailable");
    }
    if (!Array.isArray(body.keys)) fail("idp_keys_unavailable");
    const keys = body.keys as JsonWebKey[];
    cache.set(uri, { at: Date.now(), keys });
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
  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 512 || /[\u0000-\u001f]/.test(sub)) fail("invalid_token_subject");
  return { subject: { issuer: provider!.issuer, subject: sub as string }, expiresAt: exp! };
}
