/**
 * attest-verifier HTTP surface. Each route is an Effect program; failures carry a stable
 * `code` and are mapped to HTTP status at this boundary only.
 */
import { Effect } from "effect";
import type { ChainEndpoint } from "@attest/chain-evm";
import type { CriteriaRequest, GpcProofEnvelope } from "@attest/proofs";
import { requirementDigest, verifyPresentation, VerifierError } from "@attest/verifier";
import { assertCatalog, catalogDigests, defaultCatalog, type Catalog } from "./catalog";
import { ConfigError, parseConfig, type Env, type VerifierConfig } from "./config";
import { maxBlockAgeMs, noCredentialStatusRegistry, snapshotOnce, statusReader, type CredentialStatusRegistry } from "./chain";
import { checkEnrollment, EnrollmentError } from "./enrollment";
import { defaultJwksFetcher, TokenError, verifyAccessToken, type JwksFetcher } from "./idp";
import { buildPorts, holderEnrollmentName } from "./ports";

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
  holder_already_enrolled: 409,
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

const MAX_BODY_BYTES = 512 * 1024;
const readJson = (request: Request) =>
  Effect.gen(function* () {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return yield* failWith("unsupported_media_type");
    const text = yield* attempt(() => request.text());
    if (text.length > MAX_BODY_BYTES) return yield* failWith("payload_too_large");
    return yield* attempt(() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HttpFailure("invalid_json", 400);
      }
    });
  });

/** Unverified peek at the request's PEP issuer, only to namespace the replay record. */
function peekIssuer(token: unknown): string {
  try {
    const part = String(token).split(".")[1] ?? "";
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { issuer?: unknown };
    return typeof payload.issuer === "string" ? payload.issuer : "";
  } catch {
    return "";
  }
}

export function createHandler(deps: HandlerDeps) {
  const catalog = deps.catalog ?? defaultCatalog;
  assertCatalog(catalog);
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const fetchJwks = deps.fetchJwks ?? defaultJwksFetcher();
  const credentialStatus = deps.credentialStatus ?? noCredentialStatusRegistry;
  let cached: { env: Env; config: VerifierConfig } | undefined;
  const config = (env: Env) =>
    attempt(() => {
      if (cached?.env !== env) cached = { env, config: parseConfig(env) };
      return cached.config;
    });

  const presentations = (request: Request, env: Env) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const body = yield* readJson(request);
      if (body === null || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "presentation,request")
        return yield* failWith("invalid_shape");
      const { request: token, presentation } = body as { request: unknown; presentation: unknown };
      if (typeof token !== "string") return yield* failWith("invalid_jws");
      const ports = buildPorts({
        config: cfg, catalog, endpoints: () => deps.endpoints(cfg), replay: env.REPLAY, enrollments: env.ENROLLMENTS,
        credentialStatus, now: now(), newId, requestIssuer: peekIssuer(token),
        ...(deps.proofArtifacts === undefined ? {} : { proofArtifacts: deps.proofArtifacts }),
        ...(deps.verifyProof === undefined ? {} : { verifyProof: deps.verifyProof }),
      });
      const verified = yield* verifyPresentation(token, presentation, ports).pipe(Effect.mapError(toFailure));
      return json({ result: verified.token, expiresAt: verified.result.expiresAt });
    });

  const enrollments = (request: Request, env: Env) =>
    Effect.gen(function* () {
      const cfg = yield* config(env);
      const auth = request.headers.get("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(auth);
      if (!match) return yield* failWith("unauthenticated", 401);
      const at = now();
      const token = yield* attempt(() => verifyAccessToken(match[1]!, cfg.identityProviders, fetchJwks, at));
      const body = yield* readJson(request);
      const statement = yield* attempt(() => checkEnrollment(body, token.subject, cfg.verifierId, at));
      const stub = env.ENROLLMENTS.get(env.ENROLLMENTS.idFromName(holderEnrollmentName(statement.holderPublicKey)));
      const res = yield* attempt(() => stub.fetch("https://enrollments/binding", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuer: token.subject.issuer, subject: token.subject.subject, enrolledAt: at }),
      }));
      const out = (yield* attempt(() => res.json())) as { code?: string; existing?: boolean };
      if (res.status === 409) return yield* failWith(out.code ?? "holder_already_enrolled");
      if (!res.ok) return yield* failWith("enrollment_unavailable");
      return json({
        enrolled: true, subject: token.subject, holderPublicKey: statement.holderPublicKey, verifier: cfg.verifierId,
        existing: out.existing === true,
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
      const chain = yield* attempt(async () => {
        try {
          const snap = await snapshotOnce(statusReader(deps.endpoints(cfg), cfg.finality, () => at))();
          const blockAgeMs = at - Number(snap.timestamp) * 1000;
          return {
            ok: true, chainId: snap.chainId, blockNumber: Number(snap.blockNumber), blockHash: snap.blockHash,
            blockAgeMs, maxBlockAgeMs: maxBlockAgeMs(cfg.finality), finality: cfg.finality,
          };
        } catch (e) {
          return { ok: false, code: (e as { code?: string }).code ?? "chain_unavailable", finality: cfg.finality };
        }
      });
      return json({
        ok: chain.ok, service: "attest-verifier", revision, verifierId: cfg.verifierId, requirements,
        resultKeys: cfg.resultKeys.map((k) => k.kid), activeResultKey: cfg.activeResultKey.kid,
        trustedPeps: [...cfg.peps.keys()], identityProviders: cfg.identityProviders.map((p) => p.issuer),
        chain, proofBackend: "POD/GPC (beta, unaudited)",
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
