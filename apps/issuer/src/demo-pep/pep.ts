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
import type { IdentityProvider } from "../../../verifier/src/config";
import { BodyLimitError, readRequestText } from "../../../verifier/src/limits";
import {
  DEMO_LEDGER_NAME, DEMO_POLICY, DemoPepConfigError, jwks, parseDemoPepConfig, probeKeys,
  type DemoPepConfig, type DemoPepEnv,
} from "./config";
import { DEMO_TOKEN_TTL_MS, mintAccessToken, newDemoSubject } from "./identity";
import {
  appendDecision, decisionReceipt, DEMO_PEP_LEDGER_PROFILE, LedgerError, readEpoch,
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
/** Daily ceilings on what anonymous visitors can make this Durable Object store. */
export const DAILY_TOKENS = 5_000;
export const DAILY_DECISIONS = 20_000;
const MAX_EXPIRING = 20_000;

export interface DemoPepDeps {
  now?: () => number;
  /** JWKS for IdPs listed in DEMO_PEP_IDENTITY_PROVIDERS (the demo identity's own keys never leave the Worker). */
  fetchJwks?: JwksFetcher;
}

class HttpFailure {
  readonly _tag = "HttpFailure";
  constructor(readonly code: string, readonly status: number, readonly message?: string) {}
}
const STATUS: Record<string, number> = {
  not_found: 404, method_not_allowed: 405, unsupported_media_type: 415, demo_quota_exhausted: 429,
  demo_pep_misconfigured: 503, idp_keys_unavailable: 503, ledger_damaged: 503, unknown_decision: 404,
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

/** The DecisionLogAnchor configured for Sepolia in the network manifest, if any. */
export const demoLedgerAnchor = () =>
  (networkConfigs.sepolia.contracts as ContractManifest).DecisionLogAnchor?.default ?? null;

export function createDemoPep(deps: DemoPepDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const external = deps.fetchJwks ?? defaultJwksFetcher();
  let cached: { env: DemoPepEnv; config: Promise<DemoPepConfig> } | undefined;
  const config = (env: DemoPepEnv) =>
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

  const identityJwksUri = (cfg: DemoPepConfig) => `${cfg.identityIssuer}/jwks`;
  /** The demo identity first; further IdPs (Nathan) are a configuration seam. */
  const providers = (cfg: DemoPepConfig): IdentityProvider[] => [
    { issuer: cfg.identityIssuer, jwksUri: identityJwksUri(cfg), audience: cfg.issuer, allowedTyp: ["at+jwt"] },
    ...cfg.identityProviders,
  ];
  const authenticate = (request: Request, cfg: DemoPepConfig, at: number) =>
    Effect.gen(function* () {
      const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(request.headers.get("authorization") ?? "");
      if (!match) return yield* failWith("unauthenticated", 401);
      const token = yield* attempt(() => verifyAccessToken(match[1]!, providers(cfg), async (uri) =>
        uri === identityJwksUri(cfg) ? jwks(cfg.identityKeys) : external(uri), at));
      return { subject: token.subject, principalId: yield* attempt(() => principalIdOf(token.subject)) };
    });

  const readJson = (request: Request) =>
    Effect.gen(function* () {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
        return yield* failWith("unsupported_media_type");
      const text = yield* attempt(() => readRequestText(request, MAX_BODY_BYTES));
      return yield* attempt(() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new HttpFailure("invalid_json", 400);
        }
      });
    });

  /** Counts against a daily ceiling; refuses once it is reached. */
  const quota = (store: Store, kind: string, limit: number, at: number) =>
    attempt(async () => {
      const key = `quota:${new Date(at).toISOString().slice(0, 10)}:${kind}`;
      const used = (await store.get<number>(key)) ?? 0;
      if (used >= limit) throw new HttpFailure("demo_quota_exhausted", 429);
      await store.put(key, used + 1);
    });

  /** Expiring records (pending requests, facts) are purged once past expiry. */
  const expiring = {
    async add(store: Store, key: string, expiresAt: number) {
      const list = (await store.get<{ key: string; expiresAt: number }[]>("expiring")) ?? [];
      if (list.length >= MAX_EXPIRING) throw new HttpFailure("demo_quota_exhausted", 429);
      list.push({ key, expiresAt });
      await store.put("expiring", list);
    },
    async purge(store: Store, at: number) {
      const list = (await store.get<{ key: string; expiresAt: number }[]>("expiring")) ?? [];
      const keep = list.filter((e) => e.expiresAt > at);
      if (keep.length === list.length) return;
      for (const e of list) if (e.expiresAt <= at) await store.delete(e.key);
      await store.put("expiring", keep);
    },
  };

  const log = (store: Store, decision: LedgerDecision, at: number) =>
    Effect.gen(function* () {
      yield* quota(store, "decisions", DAILY_DECISIONS, at);
      return yield* attempt(() => appendDecision(store, decision));
    });

  /** Verify one returned result against the caller's own pending request, then consume it (last). */
  const accept = (store: Store, cfg: DemoPepConfig, item: unknown, principalId: string, at: number) =>
    attempt(async (): Promise<{ result: VerificationResult; fact: Fact }> => {
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
      await store.put(`req:${pending.id}`, { ...pending, consumedAt: at } satisfies PendingRequest);
      const fact: Fact = {
        credentialSubject: result.credentialSubject, expiresAt: result.expiresAt, requestId: result.requestId,
        resultId: result.id, verifier: result.issuer, requirement: result.requirement, statusSource: result.status.source,
      };
      const key = `fact:${principalId}:${result.requirement.id}:${result.credentialSubject}`;
      await store.put(key, fact);
      await expiring.add(store, key, fact.expiresAt);
      return { result, fact };
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
      await expiring.add(store, `req:${pending.id}`, pending.expiresAt);
      await store.put(`req:${pending.id}`, pending);
      await store.put(listKey, [...live.map((p) => p.id), pending.id]);
      return pending;
    });

  const authorize = (request: Request, env: DemoPepEnv, store: Store) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const at = now();
      const caller = yield* authenticate(request, cfg, at);
      const body = yield* readJson(request);
      if (body === null || typeof body !== "object" || Array.isArray(body)) return yield* failWith("invalid_shape");
      const { action, resourceId, attest } = body as { action?: unknown; resourceId?: unknown; attest?: unknown };
      for (const k of Object.keys(body)) if (!["action", "resourceId", "attest"].includes(k)) return yield* failWith("invalid_shape");
      if (typeof action !== "string" || !action || action.length > 256 || typeof resourceId !== "string" ||
        !resourceId || resourceId.length > 512)
        return yield* failWith("invalid_shape");
      yield* attempt(() => expiring.purge(store, at));
      const decisionId = `dec_${crypto.randomUUID()}`;
      const decision = (outcome: LedgerDecision["outcome"], reason: string, evidence: LedgerDecision["evidence"]): LedgerDecision => ({
        schema: DEMO_PEP_LEDGER_PROFILE.decision, id: decisionId, at, action, resourceId, outcome, reason,
        principalId: caller.principalId, policyRevision: DEMO_POLICY.revision, evidence,
      });

      if (action !== DEMO_POLICY.action || resourceId !== DEMO_POLICY.resourceId) {
        const receipt = yield* log(store, decision("deny", "no_matching_policy", []), at);
        return json({ outcome: "deny", reason: "no_matching_policy", decisionId, receipt });
      }

      // The retry: each result is verified, bound to the caller's pending request and consumed once.
      const accepted: Fact[] = [];
      if (attest !== undefined) {
        const items = Array.isArray(attest) ? attest : [attest];
        if (!items.length || items.length > 4) return yield* failWith("InvalidAttestResult", 400, "too_many_presentations");
        for (const item of items) accepted.push((yield* accept(store, cfg, item, caller.principalId, at)).fact);
      }

      const factKey = `fact:${caller.principalId}:${DEMO_POLICY.requirementId}:${DEMO_POLICY.resourceId}`;
      const held = accepted.find((f) => f.requirement.id === DEMO_POLICY.requirementId && f.credentialSubject === DEMO_POLICY.resourceId) ??
        (yield* attempt(() => store.get<Fact>(factKey)));
      const pin = cfg.verifier.requirements.find((r) => r.id === DEMO_POLICY.requirementId)!;
      if (held && held.expiresAt > at && held.requirement.digest === pin.digest && held.verifier === cfg.verifier.issuer) {
        const evidence = [{
          verifier: held.verifier, requirement: held.requirement, credentialSubject: held.credentialSubject,
          requestId: held.requestId, resultId: held.resultId, statusSource: held.statusSource, expiresAt: held.expiresAt,
        }];
        const receipt = yield* log(store, decision("allow", "policy_satisfied", evidence), at);
        return json({
          outcome: "allow", reason: "policy_satisfied", decisionId, receipt, obligations: [],
          attest: { accepted: accepted.map((f) => ({ requirementId: f.requirement.id, credentialSubject: f.credentialSubject, expiresAt: f.expiresAt })) },
          evidence,
        });
      }

      const issued = yield* issueRequest(store, cfg, caller.subject, caller.principalId, decisionId, at);
      if ("error" in issued) {
        const receipt = yield* log(store, decision("challenge", "attest_presentation_required", []), at);
        return json({ outcome: "challenge", reason: "attest_presentation_required", decisionId, receipt,
          attest: { requests: [], error: issued.error } });
      }
      const receipt = yield* log(store, decision("challenge", "attest_presentation_required", [{
        verifier: issued.request.audience, requirement: issued.request.requirement, credentialSubject: issued.request.credentialSubject,
        requestId: issued.id, expiresAt: issued.expiresAt,
      }]), at);
      const signed = yield* attempt(() => signProofRequest(issued.request, cfg.requestKeys.active.kid, cfg.requestKeys.active.privateKey));
      return json({
        outcome: "challenge", reason: "attest_presentation_required", decisionId, receipt,
        attest: { requests: [{
          requestId: issued.id, request: signed, verifier: issued.request.audience, endpoint: cfg.verifier.endpoint,
          requirement: issued.request.requirement, credentialSubject: issued.request.credentialSubject, expiresAt: issued.expiresAt,
        }] },
      });
    });

  const token = (env: DemoPepEnv, store: Store) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const at = now();
      yield* quota(store, "tokens", DAILY_TOKENS, at);
      const subject = newDemoSubject();
      const iat = Math.floor(at / 1000), exp = Math.floor((at + DEMO_TOKEN_TTL_MS) / 1000);
      const accessToken = yield* attempt(() => mintAccessToken(cfg.identityKeys.active, {
        // Audiences: this PEP, and the verifier (for holder enrollment).
        iss: cfg.identityIssuer, sub: subject, aud: [cfg.issuer, cfg.verifier.issuer], iat, exp,
        jti: crypto.randomUUID(), client_id: "attest-vendor-portal-demo",
      }));
      return json({
        access_token: accessToken, token_type: "Bearer", expires_in: exp - iat,
        subject: { issuer: cfg.identityIssuer, subject }, demo: true,
        notice: "Demo identity: anyone can mint one. It stands in for Nathan sign-in (NATH-15) and proves nothing about who you are.",
      }, 201);
    });

  const receipt = (request: Request, env: DemoPepEnv, store: Store, decisionId: string) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const at = now();
      const caller = yield* authenticate(request, cfg, at);
      const proof = yield* attempt(() => decisionReceipt(store, decisionId, caller.principalId, at));
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

  const discovery = (env: DemoPepEnv) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      return json({
        service: "attest-demo-pep", standIn: "gatekeeper", notice: DEMO_PEP_NOTICE,
        issuer: cfg.issuer, jwksUri: `${cfg.issuer}/jwks`,
        identity: { issuer: cfg.identityIssuer, jwksUri: identityJwksUri(cfg), tokenEndpoint: `${cfg.identityIssuer}/token`,
          audience: [cfg.issuer, cfg.verifier.issuer], typ: "at+jwt", demo: true },
        identityProviders: providers(cfg).map((p) => p.issuer),
        verifier: { issuer: cfg.verifier.issuer, endpoint: cfg.verifier.endpoint, requirements: cfg.verifier.requirements,
          keys: [...cfg.verifier.keys.keys()] },
        policy: DEMO_POLICY,
        ledger: { name: DEMO_LEDGER_NAME, logId: yield* attempt(() => decisionLogId(DEMO_LEDGER_NAME)),
          profile: DEMO_PEP_LEDGER_PROFILE, anchor: { network: "sepolia", address: demoLedgerAnchor() } },
      }, 200, { "cache-control": "public, max-age=60" });
    });

  return async function handle(request: Request, env: DemoPepEnv, store: Store): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const only = (allowed: string, run: () => Effect.Effect<Response, HttpFailure>) =>
      method === allowed ? run() : failWith("method_not_allowed");
    const route = (): Effect.Effect<Response, HttpFailure> => {
      const base = "/api/demo-pep";
      if (pathname === base || pathname === `${base}/`) return only("GET", () => discovery(env));
      if (pathname === `${base}/jwks`) return only("GET", () => config(env).pipe(Effect.map((c) =>
        json(jwks(c.requestKeys), 200, { "cache-control": "public, max-age=300" }))));
      if (pathname === `${base}/identity/jwks`) return only("GET", () => config(env).pipe(Effect.map((c) =>
        json(jwks(c.identityKeys), 200, { "cache-control": "public, max-age=300" }))));
      if (pathname === `${base}/identity/token`) return only("POST", () => token(env, store));
      if (pathname === `${base}/authorize`) return only("POST", () => authorize(request, env, store));
      const r = /^\/api\/demo-pep\/decisions\/(dec_[0-9a-f-]{36})\/receipt$/.exec(pathname);
      if (r) return only("GET", () => receipt(request, env, store, r[1]!));
      const e = /^\/api\/demo-pep\/epochs\/([1-9][0-9]{0,8})$/.exec(pathname);
      if (e) return only("GET", () => epoch(store, Number(e[1])));
      return failWith("not_found");
    };
    return Effect.runPromise(route().pipe(
      Effect.catch((f: HttpFailure) => Effect.succeed(json(f.message === undefined ? { code: f.code } : { code: f.code, message: f.message }, f.status))),
    ));
  };
}
