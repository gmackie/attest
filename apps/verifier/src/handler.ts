/**
 * attest-verifier HTTP surface. Each route is an Effect program; failures carry a stable
 * `code` and are mapped to HTTP status at this boundary only.
 */
import { Effect } from "effect";
import type { ChainEndpoint } from "@attest/chain-evm";
import type { CriteriaRequest, GpcProofEnvelope } from "@attest/proofs";
import { checkProofRequest, requirementDigest, verifyPresentation, VerifierError } from "@attest/verifier";
import { assertCatalog, catalogDigests, defaultCatalog, type Catalog } from "./catalog";
import { ConfigError, parseConfig, probeResultKeys, type DurableObjectStub, type Env, type VerifierConfig } from "./config";
import { BodyLimitError, readRequestText } from "./limits";
import { MAX_FAILED_ATTEMPTS } from "./replay";
import { maxBlockAgeMs, noCredentialStatusRegistry, snapshotOnce, statusReader, type CredentialStatusRegistry } from "./chain";
import { checkEnrollment, EnrollmentError } from "./enrollment";
import { defaultJwksFetcher, TokenError, verifyAccessToken, type JwksFetcher } from "./idp";
import { buildPorts, holderEnrollmentName, replayName, subjectEnrollmentName } from "./ports";

export interface HandlerDeps {
  catalog?: Catalog;
  /** Chain endpoints for the configured RPC URLs (viem clients in production). */
  endpoints(config: VerifierConfig): readonly ChainEndpoint[];
  fetchJwks?: JwksFetcher;
  credentialStatus?: CredentialStatusRegistry;
  now?: () => number;
  newId?: () => string;
  /** Local artifact path for tests; the Worker uses the pinned CDN URL resolved by its fastfile shim. */
  proofArtifacts?: string;
  verifyProof?: (proof: GpcProofEnvelope, request: CriteriaRequest, artifacts?: string) => Promise<boolean>;
}

/** HTTP status for each stable code. Everything else from verification is a 400. */
const STATUS: Record<string, number> = {
  request_replayed: 409,
  attempts_exhausted: 429,
  holder_already_enrolled: 409,
  too_many_holder_keys: 409,
  rate_limited: 429,
  status_unavailable: 503,
  chain_unavailable: 503,
  verification_unavailable: 503,
  enrollment_unavailable: 503,
  replay_store_unavailable: 503,
  verifier_misconfigured: 503,
  idp_keys_unavailable: 503,
  not_found: 404,
  method_not_allowed: 405,
  unsupported_media_type: 415,
  payload_too_large: 413,
};

class HttpFailure {
  readonly _tag = "HttpFailure";
  constructor(readonly code: string, readonly status: number) {}
}
const toFailure = (cause: unknown): HttpFailure => {
  if (cause instanceof HttpFailure) return cause;
  if (cause instanceof ConfigError) return new HttpFailure(cause.code, 503);
  if (cause instanceof BodyLimitError) return new HttpFailure(cause.code, cause.status);
  if (cause instanceof EnrollmentError) return new HttpFailure(cause.code, STATUS[cause.code] ?? cause.status);
  if (cause instanceof TokenError) return new HttpFailure(cause.code, STATUS[cause.code] ?? 401);
  if (cause instanceof VerifierError) return new HttpFailure(cause.code, STATUS[cause.code] ?? 400);
  return new HttpFailure("internal_error", 500);
};
const attempt = <A>(run: () => Promise<A> | A) =>
  Effect.tryPromise({ try: async () => run(), catch: toFailure });
const failWith = (code: string, status = STATUS[code] ?? 400) => Effect.fail(new HttpFailure(code, status));

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

export const MAX_BODY_BYTES = 512 * 1024;
/** Health chain snapshots are reused for this long, so /health cannot drive RPC load. */
export const HEALTH_CACHE_MS = 20_000;
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

const replayCall = (record: DurableObjectStub, path: "/check" | "/fail", expiresAt: number, now: number) =>
  attempt(async () => {
    const res = await record.fetch(`https://replay${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresAt, now }),
    });
    if (!res.ok) throw new VerifierError("replay_store_unavailable");
    return (await res.json()) as { consumed: boolean; failures: number; exhausted: boolean };
  });

export function createHandler(deps: HandlerDeps) {
  const catalog = deps.catalog ?? defaultCatalog;
  // Checked once, at first use; a broken catalog makes every route answer verifier_misconfigured.
  let catalogReady: Promise<void> | undefined;
  const checkCatalog = () => (catalogReady ??= assertCatalog(catalog).catch(() => {
    throw new ConfigError("catalog");
  }));
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const fetchJwks = deps.fetchJwks ?? defaultJwksFetcher();
  const credentialStatus = deps.credentialStatus ?? noCredentialStatusRegistry;
  // Parsed, catalog-checked and key-probed once per env (isolate); a failure is retried on the next request.
  let cached: { env: Env; config: Promise<VerifierConfig> } | undefined;
  const config = (env: Env) =>
    attempt(() => {
      if (cached?.env !== env) {
        const pending = (async () => {
          await checkCatalog();
          const parsed = parseConfig(env);
          await probeResultKeys(parsed.resultKeys);
          return parsed;
        })();
        cached = { env, config: pending };
        pending.catch(() => { if (cached?.config === pending) cached = undefined; });
      }
      return cached.config;
    });
  let healthChain: { config: VerifierConfig; at: number; value: Record<string, unknown> & { ok: boolean } } | undefined;

  const presentations = (request: Request, env: Env) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const body = yield* readJson(request);
      if (body === null || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "presentation,request")
        return yield* failWith("invalid_shape");
      const { request: token, presentation } = body as { request: unknown; presentation: unknown };
      if (typeof token !== "string") return yield* failWith("invalid_jws");
      const at = now();
      // Verify the request first (cheap): the replay record is named from the *verified* issuer and id,
      // and unsigned junk never touches the attempt budget.
      const { request: verified } = yield* checkProofRequest(token, {
        resolveKey: async (issuer, kid) => cfg.peps.get(issuer)?.get(kid) ?? null, audience: cfg.verifierId, now: at,
      }).pipe(Effect.mapError(toFailure));
      const record = env.REPLAY.get(env.REPLAY.idFromName(yield* attempt(() => replayName(verified.issuer, verified.id))));
      const before = yield* replayCall(record, "/check", verified.expiresAt, at);
      if (before.consumed) return yield* failWith("request_replayed");
      if (before.exhausted) return yield* failWith("attempts_exhausted");
      const ports = buildPorts({
        config: cfg, catalog, endpoints: () => deps.endpoints(cfg), replayRecord: record, enrollments: env.ENROLLMENTS,
        credentialStatus, now: at, newId,
        ...(deps.proofArtifacts === undefined ? {} : { proofArtifacts: deps.proofArtifacts }),
        ...(deps.verifyProof === undefined ? {} : { verifyProof: deps.verifyProof }),
      });
      const outcome = yield* verifyPresentation(token, presentation, ports).pipe(Effect.mapError(toFailure), Effect.result);
      if (outcome._tag === "Failure") {
        // Count every failed attempt of a validly signed request (MAX_FAILED_ATTEMPTS, then 429).
        if (outcome.failure.code !== "request_replayed")
          yield* replayCall(record, "/fail", verified.expiresAt, at).pipe(Effect.ignore);
        return yield* Effect.fail(outcome.failure);
      }
      return json({ result: outcome.success.token, expiresAt: outcome.success.result.expiresAt });
    });

  const enrollments = (request: Request, env: Env) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const auth = request.headers.get("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(auth);
      if (!match) return yield* failWith("unauthenticated", 401);
      // Per-IP limit before any token, JWKS or storage work.
      if (env.ENROLLMENT_RATE_LIMITER) {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = yield* attempt(() => env.ENROLLMENT_RATE_LIMITER!.limit({ key: `enroll:${ip}` }));
        if (!success) return yield* failWith("rate_limited");
      }
      const at = now();
      const token = yield* attempt(() => verifyAccessToken(match[1]!, cfg.identityProviders, fetchJwks, at));
      const body = yield* readJson(request);
      const statement = yield* attempt(() => checkEnrollment(body, token.subject, cfg.verifierId, at));
      const ttl = cfg.identityProviders.find((p) => p.issuer === token.subject.issuer)?.bindingTtlMs;
      const expiresAt = ttl === undefined ? null : at + ttl;
      // The subject's key budget first (at most MAX_KEYS_PER_SUBJECT active keys), then the key's binding.
      const subjectStub = env.ENROLLMENTS.get(env.ENROLLMENTS.idFromName(yield* attempt(() => subjectEnrollmentName(token.subject))));
      const reservation = (path: "reserve" | "release") => attempt(async () => {
        const res = await subjectStub.fetch(`https://enrollments/subject/${path}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ holderPublicKey: statement.holderPublicKey, now: at, expiresAt }),
        });
        return { status: res.status, body: (await res.json()) as { code?: string; added?: boolean } };
      });
      const reserved = yield* reservation("reserve");
      if (reserved.status === 409) return yield* failWith(reserved.body.code ?? "too_many_holder_keys");
      if (reserved.status !== 200) return yield* failWith("enrollment_unavailable");
      const stub = env.ENROLLMENTS.get(env.ENROLLMENTS.idFromName(holderEnrollmentName(statement.holderPublicKey)));
      const res = yield* attempt(() => stub.fetch("https://enrollments/binding", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuer: token.subject.issuer, subject: token.subject.subject, enrolledAt: at, expiresAt }),
      }));
      const out = (yield* attempt(() => res.json())) as { code?: string; existing?: boolean };
      if (!res.ok && reserved.body.added) yield* reservation("release").pipe(Effect.ignore);
      if (res.status === 409) return yield* failWith(out.code ?? "holder_already_enrolled");
      if (!res.ok) return yield* failWith("enrollment_unavailable");
      return json({
        enrolled: true, subject: token.subject, holderPublicKey: statement.holderPublicKey, verifier: cfg.verifierId,
        existing: out.existing === true, ...(expiresAt === null ? {} : { expiresAt }),
      }, out.existing ? 200 : 201);
    });

  const requirement = (id: string) =>
    Effect.gen(function* () {
      const entry = catalog.get(id);
      if (!entry) return yield* failWith("unknown_requirement", 404);
      const digest = yield* attempt(() => requirementDigest(entry.definition));
      return json({
        requirement: entry.definition, digest, title: entry.title, synthetic: entry.synthetic, notice: entry.notice,
        issuerPolicies: Object.fromEntries(Object.entries(entry.issuers).map(([issuer, p]) => [issuer,
          p.authority === "chain"
            ? { authority: "chain", status: p.status, chainId: p.chainId, registry: p.registry, account: p.account, scope: p.scope }
            : { authority: "pinned", status: p.status }])),
      }, 200, { "cache-control": "public, max-age=300" });
    });

  const jwks = (env: Env) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      return json({
        keys: cfg.resultKeys.map((k) => ({ ...k.publicKey, kid: k.kid, alg: "ES256", use: "sig" })),
      }, 200, { "cache-control": "public, max-age=300" });
    });

  const health = (env: Env) =>
    Effect.gen(function* () {
      const requirements = yield* attempt(() => catalogDigests(catalog));
      const revision = env.CF_VERSION_METADATA?.id ?? "unknown";
      const cfgResult = yield* config(env).pipe(Effect.result);
      if (cfgResult._tag === "Failure")
        return json({ ok: false, service: "attest-verifier", revision, requirements, config: { ok: false, code: cfgResult.failure.code } }, 503);
      const cfg = cfgResult.success;
      const at = now();
      if (!healthChain || healthChain.config !== cfg || at - healthChain.at >= HEALTH_CACHE_MS || at < healthChain.at) {
        const value = yield* attempt(async () => {
          try {
            const snap = await snapshotOnce(statusReader(deps.endpoints(cfg), cfg.finality, () => at))();
            return {
              ok: true, chainId: snap.chainId, blockNumber: Number(snap.blockNumber), blockHash: snap.blockHash,
              blockAgeMs: at - Number(snap.timestamp) * 1000, maxBlockAgeMs: maxBlockAgeMs(cfg.finality), finality: cfg.finality,
            };
          } catch (e) {
            return { ok: false, code: (e as { code?: string }).code ?? "chain_unavailable", finality: cfg.finality };
          }
        });
        healthChain = { config: cfg, at, value };
      }
      const chain = { ...healthChain.value, observedAt: healthChain.at };
      return json({
        ok: chain.ok, service: "attest-verifier", revision, verifierId: cfg.verifierId, requirements,
        resultKeys: cfg.resultKeys.map((k) => k.kid), activeResultKey: cfg.activeResultKey.kid,
        trustedPeps: [...cfg.peps.keys()], identityProviders: cfg.identityProviders.map((p) => p.issuer),
        chain, proofBackend: "POD/GPC (beta, unaudited)", maxFailedAttempts: MAX_FAILED_ATTEMPTS,
      }, chain.ok ? 200 : 503);
    });

  return async function fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = (): Effect.Effect<Response, HttpFailure> => {
      const { pathname } = url, method = request.method;
      const only = (allowed: string, run: () => Effect.Effect<Response, HttpFailure>) =>
        method === allowed ? run() : failWith("method_not_allowed");
      if (pathname === "/v1/presentations") return only("POST", () => presentations(request, env));
      if (pathname === "/v1/enrollments") return only("POST", () => enrollments(request, env));
      if (pathname === "/.well-known/jwks.json") return only("GET", () => jwks(env));
      if (pathname === "/health") return only("GET", () => health(env));
      const req = /^\/v1\/requirements\/([A-Za-z0-9._:-]{1,256})$/.exec(pathname);
      if (req) return only("GET", () => requirement(decodeURIComponent(req[1]!)));
      return failWith("not_found");
    };
    return Effect.runPromise(route().pipe(
      Effect.catch((failure: HttpFailure) => Effect.succeed(json({ code: failure.code }, failure.status))),
    ));
  };
}
