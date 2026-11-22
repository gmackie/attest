/**
 * Demo identity: a stand-in IdP that mints short-lived RFC 9068 (`at+jwt`) ES256 access tokens
 * for a random demo subject. It authenticates nobody: anyone can get a token. It exists so the
 * journey can run before Nathan issues RFC 9068 access tokens (NATH-15). Its subjects are
 * labelled `demo-…` and only the demo PEP and verifiers that list this issuer accept them.
 */
import type { SigningKey } from "./config";

export const DEMO_TOKEN_TTL_MS = 15 * 60_000;

const b64url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (x) => String.fromCharCode(x)).join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

export interface DemoTokenClaims {
  iss: string;
  sub: string;
  aud: string[];
  iat: number;
  exp: number;
  jti: string;
  client_id: string;
}

export async function mintAccessToken(key: SigningKey, claims: DemoTokenClaims): Promise<string> {
  const input = `${enc({ alg: "ES256", kid: key.kid, typ: "at+jwt" })}.${enc(claims)}`;
  const k = await crypto.subtle.importKey("jwk", key.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

/** A new pseudonymous demo subject. */
export const newDemoSubject = () => `demo-${crypto.randomUUID()}`;
