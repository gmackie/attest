/**
 * Demo PEP (`/api/demo-pep/*`): a clearly labelled stand-in for Gatekeeper's attest PEP
 * (GATE-10/11, docs/attest-pep.md in Gatekeeper) until Gatekeeper's attest support is deployed.
 *
 * Flow (Gatekeeper-compatible shapes):
 *   POST /authorize {action, resourceId}            → challenge with a signed attest.proof-request/v1
 *   holder presents to the verifier                 → attest.verification-result/v1
 *   POST /authorize {action, resourceId, attest}    → result verified against the pending request,
 *                                                     consumed once, then allow
 * Every decision is appended to a salted, hash-chained ledger and sealed into RFC 6962 epochs.
 *
 * Two layers, so one slow client can never stall the single Durable Object:
 *  - the **front** (in the Worker) serves discovery and JWKS from configuration, applies per-IP
 *    rate limits, authenticates the bearer token (including any IdP JWKS fetch) and reads the
 *    body (bounded size, with a deadline), then forwards a small parsed command;
 *  - the **core** (in DemoPepService, one serial queue) does only storage and signing.
 *
 * What it trusts: the verifier pinned in DEMO_PEP_VERIFIER (issuer, result keys, requirement
 * digest) for the pinned requirement only. A result is the verifier's signed assertion, not a
 * zero-knowledge proof handed to the PEP; the PEP never sees the credential or hidden values.
 * The demo identity authenticates nobody, and the demo policy lets every demo user act for
 * supplier:acme. Results are demo-grade: the accepted credential issuer's key is public.
 */
import { Effect } from "effect";
import { decisionLogId, networkConfigs, type ContractManifest } from "@attest/chain-evm";
import { canonicalJson, sha256 } from "@attest/mandates/protocol";
import {
  PROOF_REQUEST_SCHEMA, requestDigest, signProofRequest, STATUS_SOURCES, verifyVerificationResult, VerifierError,
  type ProofRequest, type SubjectRef, type VerificationResult,
} from "@attest/verifier";
import { defaultJwksFetcher, TokenError, verifyAccessToken, type JwksFetcher } from "../../../verifier/src/idp";
import type { IdentityProvider, RateLimiter } from "../../../verifier/src/config";
import { BodyLimitError, readRequestText } from "../../../verifier/src/limits";
import { SerialQueue } from "../../../verifier/src/enrollment";
import {
  DEMO_LEDGER_NAME, DEMO_POLICY, DemoPepConfigError, jwks, parseDemoPepConfig, probeKeys,
  type DemoPepConfig, type DemoPepEnv,
} from "./config";
import { DEMO_TOKEN_TTL_MS, mintAccessToken, newDemoSubject } from "./identity";
import {
  appendDecision, decisionReceipt, DEMO_PEP_LEDGER_PROFILE, LedgerError, purgeLedger, readEpoch, sealEpoch,
  type LedgerDecision, type Store,
} from "./ledger";

export const DEMO_PEP_NOTICE =
  "Demo PEP: a stand-in for Gatekeeper's attest PEP. Its demo identity authenticates nobody, its policy lets every " +
  "demo user act for supplier:acme, and the accepted credential issuer's signing key is public, so decisions are " +
  "protocol demonstrations, not authorization. Proofs use POD/GPC, a beta, unaudited backend.";
/** Gatekeeper's defaults: 5-minute requests, reused while ≥ 1 minute remains, ≤ 16 pending per principal. */
export const REQUEST_TTL_MS = 300_000;
export const REUSE_MIN_REMAINING_MS = 60_000;
export const MAX_PENDING_PER_PRINCIPAL = 16;
export const MAX_BODY_BYTES = 64 * 1024;
/** A body must arrive within this long, and is read before the serial queue. */
export const BODY_DEADLINE_MS = 10_000;
/** Daily quotas. Per IP and per principal first; the global caps are a backstop. */
export const DAILY_TOKENS_PER_IP = 50;
export const DAILY_DECISIONS_PER_PRINCIPAL = 300;
export const DAILY_TOKENS = 5_000;
export const DAILY_DECISIONS = 20_000;
/** The maintenance alarm: expiry purge, sealing, retention, old quota counters. */
export const MAINTENANCE_INTERVAL_MS = 3_600_000;
const PURGE_BATCH = 500;

export interface DemoPepEnvWithLimits extends DemoPepEnv {
  /** Workers Rate Limiting binding for POST /identity/token, keyed by client IP. */
  DEMO_PEP_TOKEN_LIMITER?: RateLimiter;
  /** Workers Rate Limiting binding for /authorize, receipts and epochs, keyed by client IP. */
  DEMO_PEP_API_LIMITER?: RateLimiter;
}
export interface DemoPepDeps {
  now?: () => number;
  /** JWKS for IdPs listed in DEMO_PEP_IDENTITY_PROVIDERS (the demo identity's own keys never leave the Worker). */
  fetchJwks?: JwksFetcher;
  bodyDeadlineMs?: number;
}

class HttpFailure {
  readonly _tag = "HttpFailure";
  constructor(readonly code: string, readonly status: number, readonly message?: string) {}
}
const STATUS: Record<string, number> = {
  not_found: 404, method_not_allowed: 405, unsupported_media_type: 415, demo_quota_exhausted: 429, rate_limited: 429,
  request_timeout: 408, demo_pep_misconfigured: 503, idp_keys_unavailable: 503, ledger_damaged: 503, unknown_decision: 404,
};
const toFailure = (cause: unknown): HttpFailure => {
  if (cause instanceof HttpFailure) return cause;
  if (cause instanceof DemoPepConfigError) return new HttpFailure(cause.code, 503);
  if (cause instanceof BodyLimitError) return new HttpFailure(cause.code, cause.status);
  if (cause instanceof TokenError) return new HttpFailure(cause.code, STATUS[cause.code] ?? 401);
  if (cause instanceof LedgerError) return new HttpFailure(cause.code, STATUS[cause.code] ?? 400);
  return new HttpFailure("internal_error", 500);
};
const attempt = <A>(run: () => Promise<A> | A) => Effect.tryPromise({ try: async () => run(), catch: toFailure });
const failWith = (code: string, status = STATUS[code] ?? 400, message?: string) =>
  Effect.fail(new HttpFailure(code, status, message));
/** Gatekeeper's error shape for refused presentations: 400 {code: "InvalidAttestResult", message: <stable code>}. */
const refuse = (code: string): never => {
  throw new HttpFailure("InvalidAttestResult", 400, code);
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
const respond = (effect: Effect.Effect<Response, HttpFailure>) =>
  Effect.runPromise(effect.pipe(Effect.catch((f: HttpFailure) =>
    Effect.succeed(json(f.message === undefined ? { code: f.code } : { code: f.code, message: f.message }, f.status)))));

interface PendingRequest {
  id: string;
  request: ProofRequest;
  digest: string;
  principalId: string;
  consumedAt: number | null;
  expiresAt: number;
}
interface Fact {
  credentialSubject: string;
  expiresAt: number;
  requestId: string;
  resultId: string;
  verifier: string;
  requirement: { id: string; digest: string };
  statusSource: string;
}
export const principalIdOf = (subject: SubjectRef) => sha256(canonicalJson({ issuer: subject.issuer, subject: subject.subject }));
const b64url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (x) => String.fromCharCode(x)).join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
/** IPs are stored only as a day-scoped digest, in quota keys that the alarm drops after the day. */
const ipKey = (ip: string, at: number) => sha256(`attest.demo-pep.ip/v1\n${day(at)}\n${ip}`);

/** The DecisionLogAnchor configured for Sepolia in the network manifest, if any. */
export const demoLedgerAnchor = () =>
  (networkConfigs.sepolia.contracts as ContractManifest).DecisionLogAnchor?.default ?? null;

/** What the front hands the core: parsed, authenticated, small. */
export type DemoPepCommand =
  | { op: "token"; ip: string }
  | { op: "authorize"; principalId: string; subject: SubjectRef; body: { action: string; resourceId: string; attest?: unknown } }
  | { op: "receipt"; principalId: string; decisionId: string }
  | { op: "epoch"; epoch: number };

/** Configuration, parsed and key-probed once per env object (isolate); a failure is retried next time. */
function configLoader() {
  let cached: { env: DemoPepEnv; config: Promise<DemoPepConfig> } | undefined;
  return (env: DemoPepEnv) =>
    attempt(() => {
      if (cached?.env !== env) {
        const pending = (async () => {
          const parsed = parseDemoPepConfig(env);
          await probeKeys(parsed.requestKeys, "DEMO_PEP_SIGNING_KEY");
          await probeKeys(parsed.identityKeys, "DEMO_IDENTITY_SIGNING_KEY");
          return parsed;
        })();
        cached = { env, config: pending };
        pending.catch(() => { if (cached?.config === pending) cached = undefined; });
      }
      return cached.config;
    });
}
const identityJwksUri = (cfg: DemoPepConfig) => `${cfg.identityIssuer}/jwks`;

/* ================================================================== front (Worker) */

export function createDemoPepFront(deps: DemoPepDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const external = deps.fetchJwks ?? defaultJwksFetcher();
  const deadline = deps.bodyDeadlineMs ?? BODY_DEADLINE_MS;
  const config = configLoader();

  /** The demo identity first; further IdPs (Nathan) are a configuration seam. */
  const providers = (cfg: DemoPepConfig): IdentityProvider[] => [
    { issuer: cfg.identityIssuer, jwksUri: identityJwksUri(cfg), audience: cfg.issuer, allowedTyp: ["at+jwt"] },
    ...cfg.identityProviders,
  ];
  const authenticate = (request: Request, cfg: DemoPepConfig) =>
    Effect.gen(function* () {
      const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(request.headers.get("authorization") ?? "");
      if (!match) return yield* failWith("unauthenticated", 401);
      const token = yield* attempt(() => verifyAccessToken(match[1]!, providers(cfg), async (uri) =>
        uri === identityJwksUri(cfg) ? jwks(cfg.identityKeys) : external(uri), now()));
      return { subject: token.subject, principalId: yield* attempt(() => principalIdOf(token.subject)) };
    });
  /** Bounded and with a deadline: a slow sender times out here, never inside the serial queue. */
  const readJson = (request: Request) =>
    Effect.gen(function* () {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
        return yield* failWith("unsupported_media_type");
      const text = yield* attempt(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            request.body?.cancel().catch(() => {});
            reject(new HttpFailure("request_timeout", 408));
          }, deadline);
        });
        return Promise.race([readRequestText(request, MAX_BODY_BYTES), timeout]).finally(() => clearTimeout(timer));
      });
      return yield* attempt(() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new HttpFailure("invalid_json", 400);
        }
      });
    });
  const limit = (limiter: RateLimiter | undefined, key: string) =>
    Effect.gen(function* () {
      if (!limiter) return;
      const { success } = yield* attempt(() => limiter.limit({ key }));
      if (!success) return yield* failWith("rate_limited");
    });

  const discovery = (cfg: DemoPepConfig) =>
    Effect.gen(function* () {
      return json({
        service: "attest-demo-pep", standIn: "gatekeeper", notice: DEMO_PEP_NOTICE,
        issuer: cfg.issuer, jwksUri: `${cfg.issuer}/jwks`,
        identity: { issuer: cfg.identityIssuer, jwksUri: identityJwksUri(cfg), tokenEndpoint: `${cfg.identityIssuer}/token`,
          audience: [cfg.issuer, cfg.verifier.issuer], typ: "at+jwt", clientId: DEMO_CLIENT_ID, demo: true },
        identityProviders: providers(cfg).map((p) => p.issuer),
        verifier: { issuer: cfg.verifier.issuer, endpoint: cfg.verifier.endpoint, requirements: cfg.verifier.requirements,
          keys: [...cfg.verifier.keys.keys()] },
        policy: DEMO_POLICY,
        ledger: { name: DEMO_LEDGER_NAME, logId: yield* attempt(() => decisionLogId(DEMO_LEDGER_NAME)),
          profile: DEMO_PEP_LEDGER_PROFILE, anchor: { network: "sepolia", address: demoLedgerAnchor() } },
      }, 200, { "cache-control": "public, max-age=60" });
    });

  return function front(request: Request, env: DemoPepEnvWithLimits,
    forward: (command: DemoPepCommand) => Promise<Response>): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const only = (allowed: string, run: () => Effect.Effect<Response, HttpFailure>) =>
      method === allowed ? run() : failWith("method_not_allowed");
    const send = (command: DemoPepCommand) => attempt(() => forward(command));
    const base = "/api/demo-pep";
    const route = (): Effect.Effect<Response, HttpFailure> => {
      // Served here from configuration only: never reaches the Durable Object.
      if (pathname === base || pathname === `${base}/`) return only("GET", () => config(env).pipe(Effect.flatMap(discovery)));
      if (pathname === `${base}/jwks`) return only("GET", () => config(env).pipe(Effect.map((c) =>
        json(jwks(c.requestKeys), 200, { "cache-control": "public, max-age=300" }))));
      if (pathname === `${base}/identity/jwks`) return only("GET", () => config(env).pipe(Effect.map((c) =>
        json(jwks(c.identityKeys), 200, { "cache-control": "public, max-age=300" }))));
      if (pathname === `${base}/identity/token`) return only("POST", () => Effect.gen(function* () {
        yield* config(env);
        yield* limit(env.DEMO_PEP_TOKEN_LIMITER, `token:${ip}`);
        return yield* send({ op: "token", ip });
      }));
      if (pathname === `${base}/authorize`) return only("POST", () => Effect.gen(function* () {
        const cfg = yield* config(env);
        yield* limit(env.DEMO_PEP_API_LIMITER, `api:${ip}`);
        const caller = yield* authenticate(request, cfg);
        const body = yield* readJson(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) return yield* failWith("invalid_shape");
        for (const k of Object.keys(body)) if (!["action", "resourceId", "attest"].includes(k)) return yield* failWith("invalid_shape");
        const { action, resourceId, attest } = body as { action?: unknown; resourceId?: unknown; attest?: unknown };
        if (typeof action !== "string" || !action || action.length > 256 || typeof resourceId !== "string" ||
          !resourceId || resourceId.length > 512)
          return yield* failWith("invalid_shape");
        return yield* send({ op: "authorize", principalId: caller.principalId, subject: caller.subject,
          body: { action, resourceId, ...(attest === undefined ? {} : { attest }) } });
      }));
      const r = /^\/api\/demo-pep\/decisions\/(dec_[0-9a-f-]{36})\/receipt$/.exec(pathname);
      if (r) return only("GET", () => Effect.gen(function* () {
        const cfg = yield* config(env);
        yield* limit(env.DEMO_PEP_API_LIMITER, `api:${ip}`);
        const caller = yield* authenticate(request, cfg);
        return yield* send({ op: "receipt", principalId: caller.principalId, decisionId: r[1]! });
      }));
      const e = /^\/api\/demo-pep\/epochs\/([1-9][0-9]{0,8})$/.exec(pathname);
      if (e) return only("GET", () => Effect.gen(function* () {
        yield* limit(env.DEMO_PEP_API_LIMITER, `api:${ip}`);
        return yield* send({ op: "epoch", epoch: Number(e[1]) });
      }));
      return failWith("not_found");
    };
    return respond(route());
  };
}
export const DEMO_CLIENT_ID = "attest-vendor-portal-demo";

/* ================================================================== core (Durable Object) */

export function createDemoPepCore(deps: Pick<DemoPepDeps, "now"> = {}) {
  const now = deps.now ?? (() => Date.now());
  const config = configLoader();

  const quotaKey = (at: number, kind: string, id?: string) => `quota:${day(at)}:${kind}${id === undefined ? "" : `:${id}`}`;
  /** All counters must have room before anything is written (L3); then each is incremented. */
  const quotas = (store: Store, at: number, counters: { key: string; limit: number }[]) => ({
    check: () => attempt(async () => {
      for (const c of counters)
        if (((await store.get<number>(c.key)) ?? 0) >= c.limit) throw new HttpFailure("demo_quota_exhausted", 429);
    }),
    spend: () => attempt(async () => {
      for (const c of counters) await store.put(c.key, ((await store.get<number>(c.key)) ?? 0) + 1);
    }),
  });
  const decisionQuotas = (store: Store, at: number, principalId: string) => quotas(store, at, [
    { key: quotaKey(at, "decisions", principalId), limit: DAILY_DECISIONS_PER_PRINCIPAL },
    { key: quotaKey(at, "decisions"), limit: DAILY_DECISIONS },
  ]);

  /** One key per expiring record (`exp:<time>:<key>`), listed in time order by the alarm. */
  const expiring = (store: Store, key: string, expiresAt: number) =>
    store.put(`exp:${String(expiresAt).padStart(16, "0")}:${key}`, 1);

  const log = (store: Store, decision: LedgerDecision) => attempt(() => appendDecision(store, decision));

  /** Verify one returned result against the caller's own pending request. Writes nothing. */
  const verifyItem = (store: Store, cfg: DemoPepConfig, item: unknown, principalId: string, at: number) =>
    attempt(async (): Promise<{ pending: PendingRequest; result: VerificationResult }> => {
      const o = (typeof item === "object" && item !== null ? item : {}) as { requestId?: unknown; result?: unknown };
      if (typeof o.requestId !== "string" || !o.requestId || o.requestId.length > 256) return refuse("unknown_request");
      const pending = await store.get<PendingRequest>(`req:${o.requestId}`);
      // A request belongs to the principal it was issued to; anyone else learns nothing about it.
      if (!pending || pending.principalId !== principalId) return refuse("unknown_request");
      if (typeof o.result !== "string") return refuse("invalid_jws");
      // The result must come from the verifier the request was addressed to, still pinned for the same digest.
      const verifier = pending.request.audience;
      const pin = cfg.verifier.requirements.find((r) => r.id === pending.request.requirement.id);
      if (verifier !== cfg.verifier.issuer || !pin || pin.digest !== pending.request.requirement.digest)
        return refuse("untrusted_verifier");
      if (pending.consumedAt !== null) return refuse("request_consumed");
      if (at >= pending.expiresAt) return refuse("request_expired");
      let result: VerificationResult;
      try {
        result = await verifyVerificationResult(o.result, {
          resolveKey: async (issuer, kid) => (issuer === verifier ? cfg.verifier.keys.get(kid) ?? null : null),
          trustedVerifier: async (issuer, requirementId) => issuer === verifier &&
            cfg.verifier.requirements.find((r) => r.id === requirementId)?.digest === pin.digest,
          audience: cfg.issuer, now: at,
          // The demo catalog's issuer is pinned (issuer-level status); every documented source is accepted
          // and the source is recorded in the decision evidence.
          acceptedStatusSources: STATUS_SOURCES,
          expected: {
            requestDigest: pending.digest, subject: pending.request.subject,
            credentialSubject: pending.request.credentialSubject, requirement: pending.request.requirement,
            ...(pending.request.decisionId === undefined ? {} : { decisionId: pending.request.decisionId }),
          },
        });
      } catch (e) {
        return refuse(e instanceof VerifierError ? e.code : "result_verification_unavailable");
      }
      if (result.requestId !== pending.id) return refuse("result_binding_mismatch");
      return { pending, result };
    });
  /** Consume a verified request and record its fact. Only called once every item and quota has passed. */
  const commit = (store: Store, principalId: string, at: number, v: { pending: PendingRequest; result: VerificationResult }) =>
    attempt(async (): Promise<Fact> => {
      await store.put(`req:${v.pending.id}`, { ...v.pending, consumedAt: at } satisfies PendingRequest);
      const r = v.result;
      const fact: Fact = {
        credentialSubject: r.credentialSubject, expiresAt: r.expiresAt, requestId: r.requestId,
        resultId: r.id, verifier: r.issuer, requirement: r.requirement, statusSource: r.status.source,
      };
      const key = `fact:${principalId}:${r.requirement.id}:${r.credentialSubject}`;
      await store.put(key, fact);
      await expiring(store, key, fact.expiresAt);
      return fact;
    });

  const issueRequest = (store: Store, cfg: DemoPepConfig, subject: SubjectRef, principalId: string, decisionId: string, at: number) =>
    attempt(async (): Promise<PendingRequest | { error: string }> => {
      if (cfg.verifier.keys.size === 0) return { error: "attest_not_configured" };
      const pin = cfg.verifier.requirements.find((r) => r.id === DEMO_POLICY.requirementId)!;
      const listKey = `pending:${principalId}`;
      const ids = (await store.get<string[]>(listKey)) ?? [];
      const live: PendingRequest[] = [];
      for (const id of ids) {
        const p = await store.get<PendingRequest>(`req:${id}`);
        if (p && p.consumedAt === null && p.expiresAt > at) live.push(p);
      }
      const reuse = live.find((p) => p.request.requirement.id === pin.id && p.request.requirement.digest === pin.digest &&
        p.request.credentialSubject === DEMO_POLICY.resourceId && p.request.audience === cfg.verifier.issuer &&
        p.expiresAt - at >= REUSE_MIN_REMAINING_MS);
      if (reuse) return reuse;
      if (live.length >= MAX_PENDING_PER_PRINCIPAL) return { error: "attest_too_many_pending" };
      const request: ProofRequest = {
        schema: PROOF_REQUEST_SCHEMA, id: `req_${crypto.randomUUID()}`, issuer: cfg.issuer, audience: cfg.verifier.issuer,
        subject, credentialSubject: DEMO_POLICY.resourceId, requirement: { id: pin.id, digest: pin.digest }, decisionId,
        nonce: b64url(crypto.getRandomValues(new Uint8Array(32))), issuedAt: at, expiresAt: at + REQUEST_TTL_MS,
      };
      const pending: PendingRequest = {
        id: request.id, request, digest: await requestDigest(request), principalId, consumedAt: null, expiresAt: request.expiresAt,
      };
      await store.put(`req:${pending.id}`, pending);
      await expiring(store, `req:${pending.id}`, pending.expiresAt);
      await store.put(listKey, [...live.map((p) => p.id), pending.id]);
      await expiring(store, listKey, pending.expiresAt);
      return pending;
    });

  const authorize = (cmd: Extract<DemoPepCommand, { op: "authorize" }>, env: DemoPepEnv, store: Store) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const at = now();
      const { principalId, subject } = cmd;
      const { action, resourceId, attest } = cmd.body;
      const quota = decisionQuotas(store, at, principalId);
      // Quota first: nothing is consumed or written for a caller who is over it.
      yield* quota.check();
      const decisionId = `dec_${crypto.randomUUID()}`;
      const decision = (outcome: LedgerDecision["outcome"], reason: string, evidence: LedgerDecision["evidence"]): LedgerDecision => ({
        schema: DEMO_PEP_LEDGER_PROFILE.decision, id: decisionId, at, action, resourceId, outcome, reason,
        principalId, policyRevision: DEMO_POLICY.revision, evidence,
      });
      const record = (d: LedgerDecision) => quota.spend().pipe(Effect.flatMap(() => log(store, d)));

      if (action !== DEMO_POLICY.action || resourceId !== DEMO_POLICY.resourceId) {
        const receipt = yield* record(decision("deny", "no_matching_policy", []));
        return json({ outcome: "deny", reason: "no_matching_policy", decisionId, receipt });
      }

      // The retry: every result is verified first; only if all pass is any request consumed.
      const accepted: Fact[] = [];
      if (attest !== undefined) {
        const items = Array.isArray(attest) ? attest : [attest];
        if (!items.length || items.length > 4) return yield* failWith("InvalidAttestResult", 400, "too_many_presentations");
        const verified: { pending: PendingRequest; result: VerificationResult }[] = [];
        for (const item of items) verified.push(yield* verifyItem(store, cfg, item, principalId, at));
        if (new Set(verified.map((v) => v.pending.id)).size !== verified.length)
          return yield* failWith("InvalidAttestResult", 400, "duplicate_request");
        for (const v of verified) accepted.push(yield* commit(store, principalId, at, v));
      }

      const factKey = `fact:${principalId}:${DEMO_POLICY.requirementId}:${DEMO_POLICY.resourceId}`;
      const held = accepted.find((f) => f.requirement.id === DEMO_POLICY.requirementId && f.credentialSubject === DEMO_POLICY.resourceId) ??
        (yield* attempt(() => store.get<Fact>(factKey)));
      const pin = cfg.verifier.requirements.find((r) => r.id === DEMO_POLICY.requirementId)!;
      if (held && held.expiresAt > at && held.requirement.digest === pin.digest && held.verifier === cfg.verifier.issuer) {
        const evidence = [{
          verifier: held.verifier, requirement: held.requirement, credentialSubject: held.credentialSubject,
          requestId: held.requestId, resultId: held.resultId, statusSource: held.statusSource, expiresAt: held.expiresAt,
        }];
        const receipt = yield* record(decision("allow", "policy_satisfied", evidence));
        return json({
          outcome: "allow", reason: "policy_satisfied", decisionId, receipt, obligations: [],
          attest: { accepted: accepted.map((f) => ({ requirementId: f.requirement.id, credentialSubject: f.credentialSubject, expiresAt: f.expiresAt })) },
          evidence,
        });
      }

      const issued = yield* issueRequest(store, cfg, subject, principalId, decisionId, at);
      if ("error" in issued) {
        const receipt = yield* record(decision("challenge", "attest_presentation_required", []));
        return json({ outcome: "challenge", reason: "attest_presentation_required", decisionId, receipt,
          attest: { requests: [], error: issued.error } });
      }
      const receipt = yield* record(decision("challenge", "attest_presentation_required", [{
        verifier: issued.request.audience, requirement: issued.request.requirement, credentialSubject: issued.request.credentialSubject,
        requestId: issued.id, expiresAt: issued.expiresAt,
      }]));
      const signed = yield* attempt(() => signProofRequest(issued.request, cfg.requestKeys.active.kid, cfg.requestKeys.active.privateKey));
      return json({
        outcome: "challenge", reason: "attest_presentation_required", decisionId, receipt,
        attest: { requests: [{
          requestId: issued.id, request: signed, verifier: issued.request.audience, endpoint: cfg.verifier.endpoint,
          requirement: issued.request.requirement, credentialSubject: issued.request.credentialSubject, expiresAt: issued.expiresAt,
        }] },
      });
    });

  const token = (cmd: Extract<DemoPepCommand, { op: "token" }>, env: DemoPepEnv, store: Store) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const at = now();
      const ip = yield* attempt(() => ipKey(cmd.ip, at));
      const quota = quotas(store, at, [
        { key: quotaKey(at, "tokens", ip), limit: DAILY_TOKENS_PER_IP },
        { key: quotaKey(at, "tokens"), limit: DAILY_TOKENS },
      ]);
      yield* quota.check();
      yield* quota.spend();
      const subject = newDemoSubject();
      const iat = Math.floor(at / 1000), exp = Math.floor((at + DEMO_TOKEN_TTL_MS) / 1000);
      const accessToken = yield* attempt(() => mintAccessToken(cfg.identityKeys.active, {
        // Audiences: this PEP, and the verifier (for holder enrollment).
        iss: cfg.identityIssuer, sub: subject, aud: [cfg.issuer, cfg.verifier.issuer], iat, exp,
        jti: crypto.randomUUID(), client_id: DEMO_CLIENT_ID,
      }));
      return json({
        access_token: accessToken, token_type: "Bearer", expires_in: exp - iat,
        subject: { issuer: cfg.identityIssuer, subject }, demo: true,
        notice: "Demo identity: anyone can mint one. It stands in for Nathan sign-in (NATH-15) and proves nothing about who you are.",
      }, 201);
    });

  const receipt = (cmd: Extract<DemoPepCommand, { op: "receipt" }>, store: Store) =>
    Effect.gen(function* () {
      const proof = yield* attempt(() => decisionReceipt(store, cmd.decisionId, cmd.principalId, now()));
      return json({
        receipt: proof, profile: DEMO_PEP_LEDGER_PROFILE,
        ledger: { name: DEMO_LEDGER_NAME, logId: yield* attempt(() => decisionLogId(DEMO_LEDGER_NAME)),
          anchor: { network: "sepolia", address: demoLedgerAnchor(), publisher: null } },
      });
    });

  const epoch = (store: Store, n: number) =>
    Effect.gen(function* () {
      const row = yield* attempt(() => readEpoch(store, n));
      if (!row) return yield* failWith("not_found");
      return json({ ...row, anchor: null }, 200, { "cache-control": "public, max-age=300" });
    });

  /** Ensures the maintenance alarm is armed. */
  const arm = async (store: Store, at: number) => {
    if (store.getAlarm && store.setAlarm && (await store.getAlarm()) === null) await store.setAlarm(at + MAINTENANCE_INTERVAL_MS);
  };

  return {
    run(command: DemoPepCommand, env: DemoPepEnv, store: Store): Promise<Response> {
      const program = command.op === "token" ? token(command, env, store)
        : command.op === "authorize" ? authorize(command, env, store)
        : command.op === "receipt" ? receipt(command, store)
        : epoch(store, command.epoch);
      return respond(program).then(async (res) => {
        await arm(store, now()).catch(() => {});
        return res;
      });
    },
    /**
     * Maintenance: drop expired requests, facts and pending lists; seal pending leaves; drop leaves past
     * retention; drop quota counters from earlier days. Bounded per run; re-arms itself.
     */
    async maintain(store: Store): Promise<{ expired: number; sealed: boolean; purgedEpochs: number; quotas: number }> {
      const at = now();
      let expired = 0;
      const due = await store.list<number>({ prefix: "exp:", limit: PURGE_BATCH });
      for (const key of due.keys()) {
        const m = /^exp:(\d{16}):(.+)$/.exec(key);
        if (!m || Number(m[1]) > at) break;
        const target = m[2]!;
        if (target.startsWith("pending:")) {
          const ids = (await store.get<string[]>(target)) ?? [];
          const live: string[] = [];
          for (const id of ids) {
            const p = await store.get<PendingRequest>(`req:${id}`);
            if (p && p.consumedAt === null && p.expiresAt > at) live.push(id);
          }
          if (live.length) await store.put(target, live); else await store.delete(target);
        } else {
          // A newer record under the same key (a renewed fact) carries its own later entry.
          const value = await store.get<{ expiresAt?: number }>(target);
          if (!value || (value.expiresAt ?? 0) <= at) await store.delete(target);
        }
        await store.delete(key);
        expired++;
      }
      let sealed = false;
      try {
        sealed = (await sealEpoch(store, at)) !== null;
      } catch {
        /* a damaged span stays unsealed; receipts for it answer ledger_damaged */
      }
      const purgedEpochs = await purgeLedger(store, at);
      let quotaKeys = 0;
      const today = `quota:${day(at)}`;
      for (const key of (await store.list({ prefix: "quota:", limit: PURGE_BATCH })).keys()) {
        if (key >= today) break;
        await store.delete(key);
        quotaKeys++;
      }
      if (store.setAlarm) await store.setAlarm(at + MAINTENANCE_INTERVAL_MS);
      return { expired, sealed, purgedEpochs, quotas: quotaKeys };
    },
  };
}

/**
 * Front and core in one process, with the core behind a serial queue: what the Worker and
 * DemoPepService do together, for tests and local use.
 */
export function createDemoPep(deps: DemoPepDeps = {}) {
  const front = createDemoPepFront(deps);
  const core = createDemoPepCore(deps);
  const queues = new WeakMap<Store, SerialQueue>();
  const handle = (request: Request, env: DemoPepEnvWithLimits, store: Store) => {
    let queue = queues.get(store);
    if (!queue) queues.set(store, (queue = new SerialQueue()));
    const q = queue;
    return front(request, env, (command) => q.run(() => core.run(command, env, store)));
  };
  return Object.assign(handle, { maintain: (store: Store) => core.maintain(store) });
}
