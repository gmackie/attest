/**
 * Worker configuration: vars and secrets, parsed and validated once per isolate.
 * Invalid configuration fails closed (503 `verifier_misconfigured`); messages
 * name the offending setting, never its value.
 */
/** An https identifier without credentials or fragment (same rule as @attest/verifier). */
export function isHttps(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

export interface DurableObjectId { toString(): string }
export interface DurableObjectStub { fetch(input: string, init?: RequestInit): Promise<Response> }
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface Env {
  VERIFIER_ID: string;
  /** JSON `[{issuer, keys: [{kid, publicKey}]}]`: pinned PEP (Gatekeeper tenant) request keys. */
  TRUSTED_PEPS: string;
  /** JSON `[{issuer, jwksUri, audience}]`: IdPs whose access tokens authenticate enrollment. */
  IDENTITY_PROVIDERS: string;
  /** Secret JSON `{active, keys: [{kid, privateKey}]}`: P-256 result signing keys. */
  RESULT_SIGNING_KEYS: string;
  SEPOLIA_RPC_URL: string;
  SEPOLIA_RPC_URL_SECONDARY: string;
  /** "finalized" or "confirmations:<n>" (default confirmations:3, as ATTE-27). */
  CHAIN_FINALITY?: string;
  REPLAY: DurableObjectNamespaceLike;
  ENROLLMENTS: DurableObjectNamespaceLike;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}

export class ConfigError extends Error {
  readonly code = "verifier_misconfigured";
  constructor(readonly setting: string) {
    super(`invalid configuration: ${setting}`);
  }
}

export interface PepKey { kid: string; publicKey: JsonWebKey }
export interface TrustedPep { issuer: string; keys: PepKey[] }
export interface IdentityProvider {
  issuer: string;
  jwksUri: string;
  audience: string;
  /** Accepted JWT `typ` header values (RFC 9068). Default ["at+jwt"]: ID tokens and other JWTs are refused. */
  allowedTyp: string[];
  /** Optional: the access token's `client_id` (or `azp`) must equal this. */
  clientId?: string;
}
export interface ResultKey { kid: string; privateKey: JsonWebKey; publicKey: JsonWebKey }
export type Finality = { kind: "finalized" } | { kind: "confirmations"; confirmations: number };

export interface VerifierConfig {
  verifierId: string;
  peps: Map<string, Map<string, JsonWebKey>>;
  identityProviders: IdentityProvider[];
  resultKeys: ResultKey[];
  activeResultKey: ResultKey;
  rpcUrls: [string, string];
  finality: Finality;
}

const kidPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function json(value: unknown, setting: string): unknown {
  if (typeof value !== "string" || value.length === 0) throw new ConfigError(setting);
  try {
    return JSON.parse(value);
  } catch {
    throw new ConfigError(setting);
  }
}
const p256 = (k: unknown): k is JsonWebKey =>
  isRecord(k) && k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string";

/** Public JWK with only the members needed to verify. Refuses any private member. */
export function publicP256(key: unknown, setting: string): JsonWebKey {
  if (!p256(key)) throw new ConfigError(setting);
  for (const member of ["d", "p", "q", "dp", "dq", "qi", "k"])
    if (Object.hasOwn(key, member)) throw new ConfigError(`${setting} (private key material)`);
  return { kty: "EC", crv: "P-256", x: key.x!, y: key.y! };
}

export function parseTrustedPeps(raw: unknown): Map<string, Map<string, JsonWebKey>> {
  const value = json(raw, "TRUSTED_PEPS");
  if (!Array.isArray(value)) throw new ConfigError("TRUSTED_PEPS");
  const peps = new Map<string, Map<string, JsonWebKey>>();
  for (const pep of value) {
    if (!isRecord(pep) || !isHttps(pep.issuer) || !Array.isArray(pep.keys) || pep.keys.length === 0 || peps.has(pep.issuer))
      throw new ConfigError("TRUSTED_PEPS");
    const keys = new Map<string, JsonWebKey>();
    for (const k of pep.keys) {
      if (!isRecord(k) || typeof k.kid !== "string" || !kidPattern.test(k.kid) || keys.has(k.kid))
        throw new ConfigError("TRUSTED_PEPS");
      keys.set(k.kid, publicP256(k.publicKey, "TRUSTED_PEPS"));
    }
    peps.set(pep.issuer, keys);
  }
  return peps;
}

export function parseIdentityProviders(raw: unknown): IdentityProvider[] {
  const value = json(raw, "IDENTITY_PROVIDERS");
  if (!Array.isArray(value)) throw new ConfigError("IDENTITY_PROVIDERS");
  const seen = new Set<string>();
  return value.map((p) => {
    if (!isRecord(p) || !isHttps(p.issuer) || !isHttps(p.jwksUri) || typeof p.audience !== "string" ||
      p.audience.length === 0 || seen.has(p.issuer))
      throw new ConfigError("IDENTITY_PROVIDERS");
    for (const k of Object.keys(p))
      if (!["issuer", "jwksUri", "audience", "allowedTyp", "clientId"].includes(k)) throw new ConfigError("IDENTITY_PROVIDERS");
    const allowedTyp = p.allowedTyp === undefined ? ["at+jwt"] : p.allowedTyp;
    if (!Array.isArray(allowedTyp) || allowedTyp.length === 0 ||
      !allowedTyp.every((t) => typeof t === "string" && t.length > 0 && t.length <= 64))
      throw new ConfigError("IDENTITY_PROVIDERS (allowedTyp)");
    if (p.clientId !== undefined && (typeof p.clientId !== "string" || p.clientId.length === 0))
      throw new ConfigError("IDENTITY_PROVIDERS (clientId)");
    seen.add(p.issuer);
    return {
      issuer: p.issuer, jwksUri: p.jwksUri, audience: p.audience, allowedTyp: allowedTyp as string[],
      ...(p.clientId === undefined ? {} : { clientId: p.clientId as string }),
    };
  });
}

export function parseResultKeys(raw: unknown): { keys: ResultKey[]; active: ResultKey } {
  const value = json(raw, "RESULT_SIGNING_KEYS");
  if (!isRecord(value) || typeof value.active !== "string" || !Array.isArray(value.keys) || value.keys.length === 0)
    throw new ConfigError("RESULT_SIGNING_KEYS");
  const keys = value.keys.map((k): ResultKey => {
    if (!isRecord(k) || typeof k.kid !== "string" || !kidPattern.test(k.kid) || !p256(k.privateKey) ||
      typeof k.privateKey.d !== "string")
      throw new ConfigError("RESULT_SIGNING_KEYS");
    const { x, y, d } = k.privateKey;
    return { kid: k.kid, privateKey: { kty: "EC", crv: "P-256", x: x!, y: y!, d }, publicKey: { kty: "EC", crv: "P-256", x: x!, y: y! } };
  });
  if (new Set(keys.map((k) => k.kid)).size !== keys.length) throw new ConfigError("RESULT_SIGNING_KEYS");
  const active = keys.find((k) => k.kid === value.active);
  if (!active) throw new ConfigError("RESULT_SIGNING_KEYS (active)");
  return { keys, active };
}

export function parseFinality(raw: unknown): Finality {
  if (raw === undefined || raw === "") return { kind: "confirmations", confirmations: 3 };
  if (raw === "finalized") return { kind: "finalized" };
  const m = typeof raw === "string" ? /^confirmations:([0-9]{1,3})$/.exec(raw) : null;
  const n = m ? Number(m[1]) : 0;
  if (n < 1 || n > 256) throw new ConfigError("CHAIN_FINALITY");
  return { kind: "confirmations", confirmations: n };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** https only; plain http is allowed solely for explicitly local hosts (Anvil, local nodes). */
export const rpcUrl = (v: unknown, setting: string) => {
  if (typeof v !== "string") throw new ConfigError(setting);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(setting);
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) return v;
  throw new ConfigError(`${setting} (https required)`);
};

export function parseConfig(env: Env): VerifierConfig {
  if (!isHttps(env.VERIFIER_ID)) throw new ConfigError("VERIFIER_ID");
  const primary = rpcUrl(env.SEPOLIA_RPC_URL, "SEPOLIA_RPC_URL");
  const secondary = rpcUrl(env.SEPOLIA_RPC_URL_SECONDARY, "SEPOLIA_RPC_URL_SECONDARY");
  if (new URL(primary).host === new URL(secondary).host) throw new ConfigError("SEPOLIA_RPC_URL_SECONDARY (same provider)");
  const results = parseResultKeys(env.RESULT_SIGNING_KEYS);
  return {
    verifierId: env.VERIFIER_ID,
    peps: parseTrustedPeps(env.TRUSTED_PEPS),
    identityProviders: parseIdentityProviders(env.IDENTITY_PROVIDERS),
    resultKeys: results.keys,
    activeResultKey: results.active,
    rpcUrls: [primary, secondary],
    finality: parseFinality(env.CHAIN_FINALITY),
  };
}

/**
 * Proves every configured result key is usable before anything is consumed: import the private
 * key, sign a probe, verify it with the public half derived from the same JWK.
 */
export async function probeResultKeys(keys: readonly ResultKey[]): Promise<void> {
  const probe = new TextEncoder().encode("attest-verifier result key probe");
  for (const key of keys) {
    let ok = false;
    try {
      const priv = await crypto.subtle.importKey("jwk", key.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const pub = await crypto.subtle.importKey("jwk", key.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, probe);
      ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, probe);
    } catch {
      ok = false;
    }
    if (!ok) throw new ConfigError(`RESULT_SIGNING_KEYS (${key.kid} unusable)`);
  }
}
