/**
 * Minimal ES256 compact JWS for Attest verifier profiles.
 * Headers and payloads are canonical JSON; alternate encodings are rejected so a
 * signature always commits to exactly one semantic document.
 */
import {canonicalJson as strictJson, keyThumbprint, MandateError, sha256} from "@attest/mandates/protocol";

export class VerifierError extends Error {
  readonly _tag = "VerifierError";
  readonly code: string;
  constructor(code: string) {super(code); this.name = "VerifierError"; this.code = code;}
}
export function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new VerifierError(code);
}
export const asVerifierError = (cause: unknown, fallback: string): VerifierError =>
  cause instanceof VerifierError ? cause :
  cause instanceof MandateError ? new VerifierError(cause.code) : new VerifierError(fallback);

/** Canonical, bounded JSON (UTF-16 key order, no coercions). */
export function canonical(value: unknown): string {
  try {return strictJson(value);} catch (cause) {throw asVerifierError(cause, "invalid_json");}
}
export const digestOf = (value: unknown): Promise<string> => sha256(canonical(value));

const encoder = new TextEncoder();
export function b64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, x => String.fromCharCode(x)).join(""))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function unb64url(value: string): Uint8Array<ArrayBuffer> {
  need(value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value), "invalid_jws");
  let bytes: Uint8Array<ArrayBuffer>;
  try {bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));}
  catch {throw new VerifierError("invalid_jws");}
  need(b64url(bytes) === value, "invalid_jws");
  return bytes;
}
async function importKey(key: JsonWebKey, usage: "sign" | "verify"): Promise<CryptoKey> {
  try {await keyThumbprint(key);} catch {throw new VerifierError("invalid_signing_key");}
  need(usage === "sign" ? typeof key.d === "string" : key.d === undefined, "invalid_signing_key");
  try {return await crypto.subtle.importKey("jwk", key, {name: "ECDSA", namedCurve: "P-256"}, false, [usage]);}
  catch {throw new VerifierError("invalid_signing_key");}
}
const keyIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export async function signJws(typ: string, payload: unknown, kid: string, privateKey: JsonWebKey): Promise<string> {
  need(keyIdPattern.test(kid), "invalid_key_id");
  const input = b64url(encoder.encode(canonical({alg: "ES256", kid, typ}))) + "." +
    b64url(encoder.encode(canonical(payload)));
  const signature = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"},
    await importKey(privateKey, "sign"), encoder.encode(input));
  return input + "." + b64url(new Uint8Array(signature));
}

export interface ParsedJws {kid: string; payload: unknown; signingInput: string; signature: Uint8Array<ArrayBuffer>}
/** Decode without trusting: the caller must verify the signature with a key it selects. */
export function parseJws(token: unknown, typ: string): ParsedJws {
  need(typeof token === "string" && token.length <= 200000, "invalid_jws");
  const parts = token.split("."); need(parts.length === 3, "invalid_jws");
  const [h, p, s] = parts as [string, string, string];
  const read = (part: string): unknown => {
    try {return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(unb64url(part)));}
    catch (cause) {throw asVerifierError(cause, "invalid_jws");}
  };
  const header = read(h), payload = read(p);
  need(header !== null && typeof header === "object" && !Array.isArray(header) &&
    Object.keys(header).sort().join(",") === "alg,kid,typ", "invalid_jws");
  const {alg, kid, typ: actual} = header as Record<string, unknown>;
  need(alg === "ES256" && actual === typ && typeof kid === "string" && keyIdPattern.test(kid), "unsupported_jws");
  need(b64url(encoder.encode(canonical(header))) === h && b64url(encoder.encode(canonical(payload))) === p,
    "noncanonical_jws");
  const signature = unb64url(s); need(signature.length === 64, "invalid_signature");
  return {kid, payload, signingInput: h + "." + p, signature};
}
export async function verifyJws(parsed: ParsedJws, publicKey: JsonWebKey): Promise<void> {
  const valid = await crypto.subtle.verify({name: "ECDSA", hash: "SHA-256"},
    await importKey(publicKey, "verify"), parsed.signature, encoder.encode(parsed.signingInput));
  need(valid, "invalid_signature");
}

// Shared field validators.
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export const isText = (v: unknown, max = 2048): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
export const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const isDigest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function isHttps(v: unknown): v is string {
  if (!isText(v)) return false;
  try {const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash;}
  catch {return false;}
}
export function shape(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  need(isRecord(v) && required.every(k => Object.hasOwn(v, k)) &&
    Object.keys(v).every(k => required.includes(k) || optional.includes(k)), "invalid_shape");
}
