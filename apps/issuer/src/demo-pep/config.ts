/**
 * Demo PEP configuration (vars and secrets), parsed once per isolate and failing closed.
 *
 * The demo PEP is a stand-in for Gatekeeper's attest PEP (GATE-10/11) until that is deployed.
 * Its shapes follow Gatekeeper's ATTEST_CONFIG / ATTEST_SIGNING_KEYS so the web journey can
 * switch to real Gatekeeper by changing a base URL. Private keys only ever come from secrets.
 */
import { parseIdentityProviders, publicP256, type IdentityProvider } from "../../../verifier/src/config";

export class DemoPepConfigError extends Error {
  readonly code = "demo_pep_misconfigured";
  constructor(readonly setting: string) {
    super(`invalid demo PEP configuration: ${setting}`);
  }
}

export interface DemoPepEnv {
  /** This PEP's https identifier: `issuer` of its proof requests, `audience` of results. */
  DEMO_PEP_ISSUER?: string;
  /** JSON `{issuer, endpoint, keys: [{kid, publicKey}], requirements: [{id, digest}]}` (Gatekeeper `verifiers[]` entry). */
  DEMO_PEP_VERIFIER?: string;
  /** Optional JSON `[{issuer, jwksUri, audience, allowedTyp?, clientId?}]`: further IdPs (seam for Nathan, NATH-15). */
  DEMO_PEP_IDENTITY_PROVIDERS?: string;
  /** Secret `{"active": kid, "keys": [{kid, privateKey}]}`: P-256 proof-request signing keys. */
  DEMO_PEP_SIGNING_KEY?: string;
  /** Secret `{"active": kid, "keys": [{kid, privateKey}]}`: P-256 keys for demo identity access tokens. */
  DEMO_IDENTITY_SIGNING_KEY?: string;
}

export interface SigningKey { kid: string; privateKey: JsonWebKey; publicKey: JsonWebKey }
export interface KeySet { active: SigningKey; keys: SigningKey[] }
export interface VerifierPin {
  issuer: string;
  endpoint: string;
  keys: Map<string, JsonWebKey>;
  requirements: { id: string; digest: string }[];
}
export interface DemoPepConfig {
  issuer: string;
  /** Demo identity issuer: `<issuer>/identity`. */
  identityIssuer: string;
  verifier: VerifierPin;
  requestKeys: KeySet;
  identityKeys: KeySet;
  /** Extra IdPs accepted for the caller's access token (the demo identity issuer is always accepted). */
  identityProviders: IdentityProvider[];
}

/** The one demo policy: approving payouts for supplier:acme requires CGL insurance ≥ $2M. */
export const DEMO_POLICY = {
  action: "vendor.payout.approve",
  resourceId: "supplier:acme",
  requirementId: "demo.insurance.cgl.min-2m",
  revision: "demo-pep.vendor-payout/1",
} as const;
export const DEFAULT_DEMO_PEP_ISSUER = "https://attest.gmac.io/api/demo-pep";
/** On-chain log id: decisionLogId(DEMO_LEDGER_NAME) = 0x6b0b609dfc1698b1d74ce391632963f26f2e8e658f85b133594967a3145a054c. */
export const DEMO_LEDGER_NAME = "attest-demo-pep";

const kidPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function isHttps(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search;
  } catch {
    return false;
  }
}
const parseJson = (raw: unknown, setting: string): unknown => {
  if (typeof raw !== "string" || raw.length === 0) throw new DemoPepConfigError(setting);
  try {
    return JSON.parse(raw);
  } catch {
    throw new DemoPepConfigError(setting);
  }
};
const publicKeyOf = (key: unknown, setting: string): JsonWebKey => {
  try {
    return publicP256(key, setting);
  } catch {
    throw new DemoPepConfigError(setting);
  }
};

export function parseKeySet(raw: unknown, setting: string): KeySet {
  const value = parseJson(raw, setting);
  if (!isRecord(value) || typeof value.active !== "string" || !Array.isArray(value.keys) || value.keys.length === 0)
    throw new DemoPepConfigError(setting);
  const keys = value.keys.map((k): SigningKey => {
    if (!isRecord(k) || typeof k.kid !== "string" || !kidPattern.test(k.kid) || !isRecord(k.privateKey) ||
      typeof k.privateKey.d !== "string")
      throw new DemoPepConfigError(setting);
    const { kty, crv, x, y } = k.privateKey;
    const publicKey = publicKeyOf({ kty, crv, x, y }, setting);
    return { kid: k.kid, privateKey: { ...publicKey, d: k.privateKey.d }, publicKey };
  });
  if (new Set(keys.map((k) => k.kid)).size !== keys.length) throw new DemoPepConfigError(setting);
  const active = keys.find((k) => k.kid === value.active);
  if (!active) throw new DemoPepConfigError(`${setting} (active)`);
  return { active, keys };
}

export function parseVerifierPin(raw: unknown): VerifierPin {
  const setting = "DEMO_PEP_VERIFIER";
  const v = parseJson(raw, setting);
  if (!isRecord(v) || !isHttps(v.issuer) || !isHttps(v.endpoint) || !Array.isArray(v.keys) ||
    !Array.isArray(v.requirements) || v.requirements.length === 0)
    throw new DemoPepConfigError(setting);
  for (const k of Object.keys(v))
    if (!["issuer", "endpoint", "keys", "requirements"].includes(k)) throw new DemoPepConfigError(setting);
  const keys = new Map<string, JsonWebKey>();
  for (const k of v.keys) {
    if (!isRecord(k) || typeof k.kid !== "string" || !kidPattern.test(k.kid) || keys.has(k.kid))
      throw new DemoPepConfigError(setting);
    // publicP256 refuses private members: a pinned verifier key must never carry `d`.
    keys.set(k.kid, publicKeyOf(k.publicKey, setting));
  }
  const requirements = v.requirements.map((r) => {
    if (!isRecord(r) || typeof r.id !== "string" || r.id.length === 0 || r.id.length > 256 ||
      typeof r.digest !== "string" || !/^[a-f0-9]{64}$/.test(r.digest))
      throw new DemoPepConfigError(setting);
    return { id: r.id, digest: r.digest };
  });
  if (new Set(requirements.map((r) => r.id)).size !== requirements.length) throw new DemoPepConfigError(setting);
  return { issuer: v.issuer, endpoint: v.endpoint, keys, requirements };
}

export function parseDemoPepConfig(env: DemoPepEnv): DemoPepConfig {
  const issuer = env.DEMO_PEP_ISSUER || DEFAULT_DEMO_PEP_ISSUER;
  if (!isHttps(issuer) || issuer.endsWith("/")) throw new DemoPepConfigError("DEMO_PEP_ISSUER");
  const verifier = parseVerifierPin(env.DEMO_PEP_VERIFIER);
  if (!verifier.requirements.some((r) => r.id === DEMO_POLICY.requirementId))
    throw new DemoPepConfigError("DEMO_PEP_VERIFIER (policy requirement not pinned)");
  let identityProviders: IdentityProvider[];
  try {
    identityProviders = parseIdentityProviders(env.DEMO_PEP_IDENTITY_PROVIDERS || "[]");
  } catch {
    throw new DemoPepConfigError("DEMO_PEP_IDENTITY_PROVIDERS");
  }
  const identityIssuer = `${issuer}/identity`;
  if (identityProviders.some((p) => p.issuer === identityIssuer))
    throw new DemoPepConfigError("DEMO_PEP_IDENTITY_PROVIDERS (demo issuer is built in)");
  const requestKeys = parseKeySet(env.DEMO_PEP_SIGNING_KEY, "DEMO_PEP_SIGNING_KEY");
  const identityKeys = parseKeySet(env.DEMO_IDENTITY_SIGNING_KEY, "DEMO_IDENTITY_SIGNING_KEY");
  const requestXs = new Set(requestKeys.keys.map((k) => k.publicKey.x));
  if (identityKeys.keys.some((k) => requestXs.has(k.publicKey.x)))
    throw new DemoPepConfigError("DEMO_IDENTITY_SIGNING_KEY (must differ from DEMO_PEP_SIGNING_KEY)");
  return { issuer, identityIssuer, verifier, requestKeys, identityKeys, identityProviders };
}

/** Every configured key must import, sign a probe and verify it with its public half. */
export async function probeKeys(set: KeySet, setting: string): Promise<void> {
  const probe = new TextEncoder().encode("attest demo PEP key probe");
  for (const key of set.keys) {
    let ok = false;
    try {
      const priv = await crypto.subtle.importKey("jwk", key.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const pub = await crypto.subtle.importKey("jwk", key.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, probe);
      ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, probe);
    } catch {
      ok = false;
    }
    if (!ok) throw new DemoPepConfigError(`${setting} (${key.kid} unusable)`);
  }
}

export const jwks = (set: KeySet) => ({
  keys: set.keys.map((k) => ({ ...k.publicKey, kid: k.kid, alg: "ES256", use: "sig" })),
});
