/**
 * Experimental Attest delegation profile. This is not a PAP, VC, or ZK format.
 * Portable Web Crypto codec; application boundaries use the Effect facade.
 */
export const MANDATE_SCHEMA = "attest.agent-mandate/v1";
export const APPROVAL_SCHEMA = "attest.agent-approval/v1";
export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type TermRule = {equals: Json} | {oneOf: Json[]} | {any: true};
export interface AgentKey {clientId: string; keyThumbprint: string}
export interface MoneyLimit {currency: string; maxPerActionMinor: number; maxTotalMinor: number}
export interface AgentMandate {
  schema: typeof MANDATE_SCHEMA; id: string; issuer: string; subject: string;
  tenant: string; delegate: AgentKey; audience: string; actions: string[];
  constraints: {resources: string[]; purposes: string[]; terms: Record<string, TermRule>; money?: MoneyLimit};
  issuedAt: number; validFrom: number; validUntil: number; statusRef: string;
  mayDelegate: boolean; maxDelegationDepth: number; parentDigest?: string;
}
export interface TransactionApproval {
  schema: typeof APPROVAL_SCHEMA; id: string; issuer: string; subject: string; tenant: string;
  delegate: AgentKey; audience: string; mandateDigest: string; operationId: string;
  revision: number; operationDigest: string; issuedAt: number; validUntil: number; statusRef: string;
}
export interface OperationContext {
  subject: string; tenant: string; actor: AgentKey; audience: string; action: string;
  resource: string; purpose: string; terms: {[key: string]: Json};
  money?: {currency: string; amountMinor: number};
}
export interface LiveStatus {
  digest: string; status: "active" | "revoked" | "superseded"; observedAt: number; validUntil: number;
}
export interface VerificationPorts {
  /** Trusted issuer-key registry. Never resolve keys or status by fetching caller URLs. */
  resolveKey(issuer: string, keyId: string): Promise<JsonWebKey | null>;
  authorizedIssuer(issuer: string, subject: string, kind: "mandate" | "approval"): Promise<boolean>;
  status(statusRef: string, digest: string): Promise<LiveStatus | null>;
  now(): number;
  maxStatusAgeMs: number;
}
export interface VerifiedMandateChain {mandates: AgentMandate[]; digests: string[]; expiresAt: number}
export class MandateError extends Error {
  readonly _tag = "MandateError";
  readonly code: string;
  constructor(code: string) {super(code); this.name = "MandateError"; this.code = code;}
}
export function demand(condition: unknown, code: string): asserts condition {
  if (!condition) throw new MandateError(code);
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 2048 && !/[\u0000-\u001f]/.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const digestPattern = /^[a-f0-9]{64}$/;
const thumbprintPattern = /^[A-Za-z0-9_-]{43}$/;
function https(v: unknown): boolean {
  if (!text(v)) return false;
  try {const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash;} catch {return false;}
}
function shape(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  demand(record(v) && required.every(k => Object.hasOwn(v, k)) &&
    Object.keys(v).every(k => required.includes(k) || optional.includes(k)), "invalid_shape");
}
function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(text) && new Set(v).size === v.length &&
    v.every(x => !x.includes("*"));
}
/** Pin UTF-16 object-key ordering and bounded, dense, plain JSON. No silent coercions. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>(); let nodes = 0;
  const visit = (v: unknown, depth: number): Json => {
    demand(++nodes <= 10000 && depth <= 16, "json_budget");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {demand(Number.isFinite(v) && !Object.is(v, -0), "invalid_json_number"); return v;}
    demand(record(v) || Array.isArray(v), "invalid_json");
    demand(!seen.has(v) && Object.getOwnPropertySymbols(v).length === 0, "invalid_json");
    demand(Array.isArray(v) || [Object.prototype, null].includes(Object.getPrototypeOf(v)), "invalid_json");
    seen.add(v);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && k === "length") continue;
      demand(Object.hasOwn(d, "value") && d.enumerable &&
        !["__proto__", "constructor", "prototype"].includes(k), "invalid_json");
    }
    let result: Json;
    if (Array.isArray(v)) {
      demand(Object.keys(v).length === v.length && Object.keys(v).every((k, i) => k === String(i)), "invalid_json");
      result = v.map(x => visit(x, depth + 1));
    } else {
      result = Object.fromEntries(Object.keys(v).sort().map(k => [k, visit(v[k], depth + 1)]));
    }
    seen.delete(v); return result;
  };
  const serialize = (v: Json): string => Array.isArray(v) ? "[" + v.map(serialize).join(",") + "]" :
    v !== null && typeof v === "object" ? "{" + Object.keys(v).sort().map(k =>
      JSON.stringify(k) + ":" + serialize(v[k]!)).join(",") + "}" : JSON.stringify(v);
  const json = serialize(visit(value, 0));
  demand(new TextEncoder().encode(json).length <= 65536, "json_budget");
  return json;
}
function agent(value: unknown): asserts value is AgentKey {
  shape(value, ["clientId", "keyThumbprint"]);
  demand(https(value.clientId) && typeof value.keyThumbprint === "string" &&
    thumbprintPattern.test(value.keyThumbprint), "invalid_agent_key");
}
function validateTerms(value: unknown): void {
  demand(record(value) && Object.keys(value).length <= 64, "invalid_term_rules");
  for (const [key, rule] of Object.entries(value)) {
    demand(text(key) && record(rule), "invalid_term_rules");
    if (Object.hasOwn(rule, "equals")) shape(rule, ["equals"]);
    else if (Object.hasOwn(rule, "oneOf")) {
      shape(rule, ["oneOf"]);
      demand(Array.isArray(rule.oneOf) && rule.oneOf.length > 0 && rule.oneOf.length <= 64 &&
        new Set(rule.oneOf.map(canonicalJson)).size === rule.oneOf.length, "invalid_term_rules");
    } else {shape(rule, ["any"]); demand(rule.any === true, "invalid_term_rules");}
  }
}
export function parseMandate(value: unknown): AgentMandate {
  canonicalJson(value);
  shape(value, ["schema", "id", "issuer", "subject", "tenant", "delegate", "audience", "actions",
    "constraints", "issuedAt", "validFrom", "validUntil", "statusRef", "mayDelegate", "maxDelegationDepth"], ["parentDigest"]);
  demand(value.schema === MANDATE_SCHEMA, "unsupported_mandate_schema");
  for (const k of ["id", "issuer", "subject", "tenant", "statusRef"]) demand(text(value[k]), "invalid_mandate_field");
  agent(value.delegate);
  demand(https(value.audience) && strings(value.actions), "invalid_mandate_scope");
  shape(value.constraints, ["resources", "purposes", "terms"], ["money"]);
  demand(strings(value.constraints.resources) && strings(value.constraints.purposes), "invalid_mandate_scope");
  validateTerms(value.constraints.terms);
  if (Object.hasOwn(value.constraints, "money")) {
    const m = value.constraints.money;
    shape(m, ["currency", "maxPerActionMinor", "maxTotalMinor"]);
    demand(typeof m.currency === "string" && /^[A-Z]{3}$/.test(m.currency) &&
      time(m.maxPerActionMinor) && time(m.maxTotalMinor) && m.maxPerActionMinor <= m.maxTotalMinor, "invalid_money_limit");
  }
  demand(time(value.issuedAt) && time(value.validFrom) && time(value.validUntil) &&
    value.issuedAt <= value.validFrom && value.validFrom < value.validUntil, "invalid_mandate_time");
  demand(typeof value.mayDelegate === "boolean" && time(value.maxDelegationDepth) && value.maxDelegationDepth <= 8 &&
    (value.mayDelegate ? value.maxDelegationDepth > 0 : value.maxDelegationDepth === 0), "invalid_delegation_depth");
  demand(!Object.hasOwn(value, "parentDigest") ||
    (typeof value.parentDigest === "string" && digestPattern.test(value.parentDigest)), "invalid_parent_digest");
  return structuredClone(value) as unknown as AgentMandate;
}
export function parseApproval(value: unknown): TransactionApproval {
  canonicalJson(value);
  shape(value, ["schema", "id", "issuer", "subject", "tenant", "delegate", "audience", "mandateDigest",
    "operationId", "revision", "operationDigest", "issuedAt", "validUntil", "statusRef"]);
  demand(value.schema === APPROVAL_SCHEMA, "unsupported_approval_schema");
  for (const k of ["id", "issuer", "subject", "tenant", "operationId", "statusRef"]) demand(text(value[k]), "invalid_approval_field");
  agent(value.delegate);
  demand(https(value.audience) && typeof value.mandateDigest === "string" && digestPattern.test(value.mandateDigest) &&
    typeof value.operationDigest === "string" && digestPattern.test(value.operationDigest) &&
    time(value.revision) && value.revision > 0 && time(value.issuedAt) && time(value.validUntil) &&
    value.issuedAt < value.validUntil, "invalid_approval_binding");
  return structuredClone(value) as unknown as TransactionApproval;
}
const encoder = new TextEncoder();
function b64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, x => String.fromCharCode(x)).join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function unb64(value: string): Uint8Array<ArrayBuffer> {
  demand(value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value), "invalid_jws");
  let bytes: Uint8Array<ArrayBuffer>;
  try {bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));}
  catch {throw new MandateError("invalid_jws");}
  demand(b64(bytes) === value, "invalid_jws"); return bytes;
}
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, "0")).join("");
}
/** Payload commitment stays stable across fresh or malleated ECDSA signatures. */
export const documentDigest = (value: AgentMandate | TransactionApproval): Promise<string> =>
  sha256(canonicalJson(value.schema === MANDATE_SCHEMA ? parseMandate(value) : parseApproval(value)));
export async function keyThumbprint(key: JsonWebKey): Promise<string> {
  demand(key.kty === "EC" && key.crv === "P-256" && typeof key.x === "string" && typeof key.y === "string", "invalid_signing_key");
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson({crv: key.crv, kty: key.kty, x: key.x, y: key.y})));
  return b64(new Uint8Array(bytes));
}
async function signingKey(key: JsonWebKey, usage: "sign" | "verify"): Promise<CryptoKey> {
  await keyThumbprint(key);
  demand(usage === "sign" ? typeof key.d === "string" : key.d === undefined, "invalid_signing_key");
  try {return await crypto.subtle.importKey("jwk", key, {name: "ECDSA", namedCurve: "P-256"}, false, [usage]);}
  catch {throw new MandateError("invalid_signing_key");}
}
export async function signDocument(value: AgentMandate | TransactionApproval, keyId: string, key: JsonWebKey): Promise<string> {
  const document = value.schema === MANDATE_SCHEMA ? parseMandate(value) : parseApproval(value);
  demand(text(keyId), "invalid_key_id");
  const input = b64(encoder.encode(canonicalJson({alg: "ES256", kid: keyId, typ: document.schema}))) +
    "." + b64(encoder.encode(canonicalJson(document)));
  const signature = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, await signingKey(key, "sign"), encoder.encode(input));
  return input + "." + b64(new Uint8Array(signature));
}
async function verifyDocument(token: string, schema: string, ports: VerificationPorts): Promise<{
  document: AgentMandate | TransactionApproval; digest: string; signingThumbprint: string; statusExpiresAt: number;
}> {
  demand(typeof token === "string" && token.length <= 100000, "invalid_jws");
  const parts = token.split("."); demand(parts.length === 3, "invalid_jws");
  const [h, p, s] = parts as [string, string, string];
  const read = (part: string): unknown => {
    try {return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(unb64(part)));}
    catch {throw new MandateError("invalid_jws");}
  };
  const header = read(h); shape(header, ["alg", "kid", "typ"]);
  demand(header.alg === "ES256" && header.typ === schema && text(header.kid), "unsupported_jws");
  const payload = read(p);
  const document = schema === MANDATE_SCHEMA ? parseMandate(payload) : parseApproval(payload);
  // Reject duplicate keys, alternate JSON spellings, and representations with unsigned semantics.
  demand(b64(encoder.encode(canonicalJson(header))) === h &&
    b64(encoder.encode(canonicalJson(document))) === p, "noncanonical_jws");
  const key = await ports.resolveKey(document.issuer, header.kid);
  demand(key, "issuer_key_unavailable");
  const signature = unb64(s); demand(signature.length === 64, "invalid_signature");
  const valid = await crypto.subtle.verify({name: "ECDSA", hash: "SHA-256"},
    await signingKey(key, "verify"), signature, encoder.encode(h + "." + p));
  demand(valid, "invalid_signature");
  const digest = await documentDigest(document);
  demand(time(ports.now()) && time(ports.maxStatusAgeMs) && ports.maxStatusAgeMs > 0 && ports.maxStatusAgeMs <= 60000,
    "invalid_verification_clock");
  const status = await ports.status(document.statusRef, digest);
  const now = ports.now();
  demand(status && status.digest === digest && status.status === "active" &&
    time(status.observedAt) && time(status.validUntil) && status.observedAt <= now &&
    now < status.validUntil && now - status.observedAt < ports.maxStatusAgeMs, "status_unavailable");
  demand(document.issuedAt <= now && now < document.validUntil, "document_expired");
  return {document, digest, signingThumbprint: await keyThumbprint(key),
    statusExpiresAt: Math.min(status.validUntil, status.observedAt + ports.maxStatusAgeMs)};
}
const equal = (a: Json, b: Json): boolean => canonicalJson(a) === canonicalJson(b);
function covers(rule: TermRule, value: Json): boolean {
  return "any" in rule || ("equals" in rule ? equal(rule.equals, value) : rule.oneOf.some(v => equal(v, value)));
}
function narrows(child: TermRule, parent: TermRule): boolean {
  if ("any" in parent) return true;
  if ("any" in child) return false;
  return ("equals" in child ? [child.equals] : child.oneOf).every(v => covers(parent, v));
}
function attenuation(parent: AgentMandate, child: AgentMandate): void {
  demand(parent.mayDelegate && child.maxDelegationDepth < parent.maxDelegationDepth &&
    child.issuedAt >= parent.issuedAt && child.validFrom >= parent.validFrom && child.validUntil <= parent.validUntil &&
    child.subject === parent.subject && child.tenant === parent.tenant && child.audience === parent.audience, "delegation_not_narrowed");
  const subset = (a: string[], b: string[]) => a.every(x => b.includes(x));
  demand(subset(child.actions, parent.actions) && subset(child.constraints.resources, parent.constraints.resources) &&
    subset(child.constraints.purposes, parent.constraints.purposes), "delegation_not_narrowed");
  const p = parent.constraints.terms, c = child.constraints.terms;
  demand(Object.keys(p).length === Object.keys(c).length &&
    Object.entries(p).every(([k, rule]) => Object.hasOwn(c, k) && narrows(c[k]!, rule)), "delegation_not_narrowed");
  const pm = parent.constraints.money, cm = child.constraints.money;
  demand(pm ? cm && cm.currency === pm.currency && cm.maxPerActionMinor <= pm.maxPerActionMinor &&
    cm.maxTotalMinor <= pm.maxTotalMinor : !cm, "delegation_not_narrowed");
}
export async function verifyMandateChain(tokens: readonly string[], ports: VerificationPorts): Promise<VerifiedMandateChain> {
  demand(Array.isArray(tokens) && tokens.length > 0 && tokens.length <= 9, "invalid_mandate_chain");
  const mandates: AgentMandate[] = [], digests: string[] = [], leases: number[] = [];
  for (const token of tokens) {
    const verified = await verifyDocument(token, MANDATE_SCHEMA, ports);
    const m = verified.document as AgentMandate;
    demand(m.validFrom <= ports.now() && !digests.includes(verified.digest) && !mandates.some(x => x.id === m.id),
      "invalid_mandate_chain");
    if (mandates.length === 0) {
      demand(m.parentDigest === undefined && await ports.authorizedIssuer(m.issuer, m.subject, "mandate"),
        "unauthorized_mandate_issuer");
    } else {
      const parent = mandates[mandates.length - 1]!;
      demand(m.parentDigest === digests[digests.length - 1] && m.issuer === parent.delegate.clientId &&
        verified.signingThumbprint === parent.delegate.keyThumbprint, "invalid_delegation_link");
      attenuation(parent, m);
    }
    mandates.push(m); digests.push(verified.digest); leases.push(verified.statusExpiresAt);
  }
  const now = ports.now();
  demand(mandates.every(m => m.validFrom <= now && now < m.validUntil), "document_expired");
  const expiresAt = Math.min(...mandates.map(m => m.validUntil), ...leases);
  demand(now < expiresAt, "status_unavailable");
  return {mandates, digests, expiresAt};
}
/** Local constraint match only. Aggregate limits must also be reserved atomically by the executor. */
export function assertMandateContext(chain: VerifiedMandateChain, value: OperationContext, now: number): void {
  canonicalJson(value);
  shape(value, ["subject", "tenant", "actor", "audience", "action", "resource", "purpose", "terms"], ["money"]);
  agent(value.actor);
  for (const k of ["subject", "tenant", "action", "resource", "purpose"]) demand(text(value[k]), "invalid_operation_context");
  demand(https(value.audience) && record(value.terms) && time(now) && chain.mandates.length > 0 &&
    chain.mandates.length === chain.digests.length && now < chain.expiresAt, "invalid_operation_context");
  if (value.money) {
    shape(value.money, ["currency", "amountMinor"]);
    demand(/^[A-Z]{3}$/.test(value.money.currency) && time(value.money.amountMinor), "invalid_operation_money");
  }
  const leaf = chain.mandates[chain.mandates.length - 1]!;
  demand(leaf.delegate.clientId === value.actor.clientId &&
    leaf.delegate.keyThumbprint === value.actor.keyThumbprint, "delegate_mismatch");
  for (const m of chain.mandates) {
    demand(m.validFrom <= now && now < m.validUntil && m.subject === value.subject &&
      m.tenant === value.tenant && m.audience === value.audience, "mandate_binding_mismatch");
    demand(m.actions.includes(value.action) && m.constraints.resources.includes(value.resource) &&
      m.constraints.purposes.includes(value.purpose), "mandate_scope_denied");
    const rules = m.constraints.terms;
    demand(Object.keys(rules).length === Object.keys(value.terms).length &&
      Object.entries(value.terms).every(([key, term]) => Object.hasOwn(rules, key) && covers(rules[key]!, term)),
      "mandate_terms_denied");
    if (value.money) {
      const money = m.constraints.money;
      demand(money && value.money.currency === money.currency &&
        value.money.amountMinor <= money.maxPerActionMinor, "mandate_amount_denied");
    }
  }
}
export async function verifyTransactionApproval(token: string, expected: {
  context: OperationContext; mandateDigest: string; operationId: string; revision: number; operationDigest: string;
}, ports: VerificationPorts): Promise<TransactionApproval> {
  const {document, statusExpiresAt} = await verifyDocument(token, APPROVAL_SCHEMA, ports);
  const a = document as TransactionApproval, c = expected.context;
  demand(await ports.authorizedIssuer(a.issuer, a.subject, "approval"), "unauthorized_approval_issuer");
  demand(a.subject === c.subject && a.tenant === c.tenant && a.audience === c.audience &&
    a.delegate.clientId === c.actor.clientId && a.delegate.keyThumbprint === c.actor.keyThumbprint &&
    a.mandateDigest === expected.mandateDigest && a.operationId === expected.operationId &&
    a.revision === expected.revision && a.operationDigest === expected.operationDigest, "approval_binding_mismatch");
  demand(ports.now() < Math.min(a.validUntil, statusExpiresAt), "document_expired");
  return a;
}
