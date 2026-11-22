import path from "node:path";
import { readFileSync } from "node:fs";
import { decodePublicKey, deriveSignerPublicKey, encodePublicKey, POD } from "@pcd/pod";
import { Effect } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Hooks generate real GPC proofs; under CI or host load they can exceed the 10 s default and
// silently skip the suites they set up.
vi.setConfig({ hookTimeout: 120_000 });
import type { ChainEndpoint } from "@attest/chain-evm";
import { commitValue } from "@attest/core";
import { DEMO_INSURANCE_ISSUER_PRIVATE_KEY } from "@attest/domains";
import { issueCriteriaPod } from "@attest/proofs";
import {
  canonicalPresentationBody, canonicalPublicKey, checkVerificationResult, present, PRESENTATION_SCHEMA, PROOF_REQUEST_SCHEMA,
  requestDigest, requirementDigest, signProofRequest,
  type Presentation, type ProofRequest, type RequirementDefinition, type SubjectRef,
} from "@attest/verifier";
import {
  cglMin2m, DEMO_CARRIER_ID, DEMO_CARRIER_PUBLIC_KEY, defaultCatalog, type Catalog, type CatalogEntry,
} from "../src/catalog";
import { ConfigError, parseIdentityProviders, parseTrustedPeps, rpcUrl, type DurableObjectNamespaceLike, type Env } from "../src/config";
import { ENROLLMENT_SCHEMA, EnrollmentStore, MAX_KEYS_PER_SUBJECT, signEnrollment, type DurableState, type EnrollmentStatement } from "../src/enrollment";
import { createHandler, HEALTH_CACHE_MS, MAX_BODY_BYTES, type HandlerDeps } from "../src/handler";
import { defaultJwksFetcher, JWKS_FAILURE_TTL_MS } from "../src/idp";
import { replayName } from "../src/ports";
import { MAX_FAILED_ATTEMPTS, ReplayStore, REPLAY_PURGE_SKEW_MS } from "../src/replay";
import { ANCHOR_PROFILE } from "../src/chain";

const artifacts = path.resolve(import.meta.dirname, "../node_modules/@pcd/proto-pod-gpc-artifacts");
const NOW = 1_795_300_000_000;
const DEMO_DIGEST = "2251414534a86a6cbe9b53d6a030b6fbe4437f8d1e7341ec0bc91246846b3d20";
const VERIFIER = "https://verify.attest.example";
const PEP = "https://gatekeeper.example/api/attest/tenants/acme";
const IDP = "https://login.acme.example/api/auth";
const IDP_AUDIENCE = "attest-verifier";
const user: SubjectRef = { issuer: IDP, subject: "user_8f2c" };
const holderKey = "11".repeat(32), strangerKey = "44".repeat(32);
const holderPublicKey = deriveSignerPublicKey(holderKey);
const fields = { aggregate: 5_000_000, per_occurrence: 2_000_000 };

/* ---------------------------------------------------------------- keys and tokens */

type Pair = { privateKey: JsonWebKey; publicKey: JsonWebKey };
async function p256(): Promise<Pair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey, publicKey: { kty: "EC", crv: "P-256", x: publicKey.x!, y: publicKey.y! } };
}
const b64 = (v: string | Uint8Array) => Buffer.from(v).toString("base64url");
async function jwt(claims: Record<string, unknown>, key: JsonWebKey, kid = "idp-1", typ: string | null = "at+jwt") {
  const input = `${b64(JSON.stringify({ alg: "ES256", kid, ...(typ === null ? {} : { typ }) }))}.${b64(JSON.stringify(claims))}`;
  const k = await crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, new TextEncoder().encode(input)));
  return `${input}.${b64(sig)}`;
}

/* ---------------------------------------------------------------- fake Durable Objects */

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
class MemoryStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  /** Artificial storage latency, to expose interleaving between concurrent requests. */
  latencyMs = 0;
  async get<T>(key: string) { if (this.latencyMs) await tick(this.latencyMs); return structuredClone(this.data.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { if (this.latencyMs) await tick(this.latencyMs); this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async deleteAll() { this.data.clear(); }
  async setAlarm(at: number) { this.alarm = at; }
}
class FakeNamespace<T extends { fetch(r: Request): Promise<Response> }> implements DurableObjectNamespaceLike {
  instances = new Map<string, { object: T; storage: MemoryStorage }>();
  constructor(private make: (state: DurableState) => T) {}
  idFromName(name: string) { return { toString: () => name }; }
  get(id: { toString(): string }) {
    const name = id.toString();
    let entry = this.instances.get(name);
    if (!entry) {
      const storage = new MemoryStorage();
      entry = { object: this.make({ storage }), storage };
      this.instances.set(name, entry);
    }
    const object = entry.object;
    return { fetch: (input: string, init?: RequestInit) => object.fetch(new Request(input, init)) };
  }
}

/* ---------------------------------------------------------------- fake Sepolia (two agreeing RPCs) */

type Grant = [boolean, `0x${string}`];
type Anchor = [`0x${string}`, `0x${string}`, `0x${string}`, bigint, boolean];
const ZERO_ANCHOR: Anchor = ["0x" + "0".repeat(40) as `0x${string}`, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, 0n, false];
class FakeChain {
  snapshots = 0;
  head = 1000n;
  headTime = BigInt(NOW / 1000 - 12);
  grants = new Map<string, Grant>();
  anchors = new Map<string, Anchor>();
  chainId = 11155111;
  endpoint(name: string): ChainEndpoint {
    const hash = (n: bigint) => `0x${n.toString(16).padStart(64, "a")}` as `0x${string}`;
    return {
      name,
      client: {
        getChainId: async () => { this.snapshots += name === "primary" ? 1 : 0; return this.chainId; },
        getBlock: async (args) => {
          const n = "blockNumber" in args ? args.blockNumber : this.head;
          return { number: n, hash: hash(n), timestamp: this.headTime - (this.head - n) * 12n };
        },
        readContract: async (args) => {
          const a = (args.args ?? []) as string[];
          if (args.functionName === "issuers") return this.grants.get(`${a[0]!.toLowerCase()}|${a[1]}`) ?? [false, `0x${"0".repeat(64)}`];
          if (args.functionName === "anchors") return this.anchors.get(a[0]!) ?? ZERO_ANCHOR;
          // The deployed Sepolia registry is V1: workspaceAnchorStatus checks the version (ATTE-23).
          if (args.functionName === "registryVersion") return 1n;
          throw new Error("unexpected read");
        },
      },
    };
  }
}

/* ---------------------------------------------------------------- a chain-anchored test issuer */

const chainCarrierKey = "55".repeat(32);
const CHAIN_ISSUER = "issuer:chain-carrier";
const REGISTRY = "0x00000000000000000000000000000000000000a1" as const;
const CHAIN_ACCOUNT = "0x00000000000000000000000000000000000000b2" as const;
let chainEntry: CatalogEntry;
let catalog: Catalog;

/* ---------------------------------------------------------------- world */

let pep: Pair, rogue: Pair, resultKey: Pair, oldResultKey: Pair, idp: Pair, otherIdp: Pair;
const baseRequest = (over: Partial<ProofRequest> = {}): ProofRequest => ({
  schema: PROOF_REQUEST_SCHEMA, id: `req-${crypto.randomUUID()}`, issuer: PEP, audience: VERIFIER, subject: user,
  credentialSubject: "supplier:acme", requirement: { id: cglMin2m.definition.id, digest: defaultDigest },
  decisionId: "dec-7", nonce: "n0nce-0123456789abcdefghij", issuedAt: NOW - 1000, expiresAt: NOW + 300_000, ...over,
});
let defaultDigest: string, chainDigest: string;

function makeEnv(over: Partial<Env> = {}) {
  const replay = new FakeNamespace((s) => new ReplayStore(s));
  const enrollments = new FakeNamespace((s) => new EnrollmentStore(s));
  const env: Env = {
    VERIFIER_ID: VERIFIER,
    TRUSTED_PEPS: JSON.stringify([{ issuer: PEP, keys: [{ kid: "pep-1", publicKey: pep.publicKey }] }]),
    IDENTITY_PROVIDERS: JSON.stringify([{ issuer: IDP, jwksUri: "https://login.acme.example/jwks", audience: IDP_AUDIENCE }]),
    RESULT_SIGNING_KEYS: JSON.stringify({ active: "verifier-2", keys: [
      { kid: "verifier-1", privateKey: oldResultKey.privateKey }, { kid: "verifier-2", privateKey: resultKey.privateKey },
    ] }),
    SEPOLIA_RPC_URL: "https://rpc-a.example", SEPOLIA_RPC_URL_SECONDARY: "https://rpc-b.example",
    REPLAY: replay, ENROLLMENTS: enrollments, CF_VERSION_METADATA: { id: "rev-test" },
    ...over,
  };
  return { env, replay, enrollments };
}
let clock = NOW;
function makeHandler(chain: FakeChain, over: Partial<HandlerDeps> = {}) {
  let n = 0;
  return createHandler({
    catalog, endpoints: () => [chain.endpoint("primary"), chain.endpoint("secondary")],
    fetchJwks: async (uri) => {
      if (uri !== "https://login.acme.example/jwks") throw new Error("unexpected jwks uri");
      return { keys: [{ ...idp.publicKey, kid: "idp-1", alg: "ES256", use: "sig" } as JsonWebKey] };
    },
    now: () => clock, newId: () => `res-${++n}`, proofArtifacts: artifacts, ...over,
  });
}
const post = (handler: ReturnType<typeof createHandler>, env: Env, pathName: string, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  return handler(new Request(`https://verify.attest.example${pathName}`, {
    method: "POST", body: text,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers },
  }), env);
};
/** Replay records that were actually consumed (failed attempts also create a record). */
const consumed = (replay: FakeNamespace<ReplayStore>) =>
  [...replay.instances.values()].filter((i) => (i.storage.data.get("request") as { consumed?: unknown } | undefined)?.consumed).length;
const get = (handler: ReturnType<typeof createHandler>, env: Env, pathName: string) =>
  handler(new Request(`https://verify.attest.example${pathName}`), env);
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

const sign = (r: ProofRequest, key = pep.privateKey, kid = "pep-1") => signProofRequest(r, kid, key);
const credential = (issuerKey: string, definition: RequirementDefinition, holder = holderPublicKey) =>
  issueCriteriaPod({ schema: definition.schema, subject: "supplier:acme", holderPublicKey: holder,
    issuerPublicKey: deriveSignerPublicKey(issuerKey), challenge: "unused", criteria: definition.criteria }, fields, issuerKey);
/** A real GPC presentation (slow). */
const prove = (r: ProofRequest, entry: CatalogEntry = cglMin2m, issuerKey = DEMO_INSURANCE_ISSUER_PRIVATE_KEY,
  issuerId = DEMO_CARRIER_ID, privateKey = holderKey) =>
  Effect.runPromise(present({ request: r, definition: entry.definition, credential: credential(issuerKey, entry.definition,
    deriveSignerPublicKey(privateKey)), credentialIssuer: issuerId, credentialSubject: "supplier:acme",
    holderPrivateKey: privateKey, artifacts }));
/** Correctly bound and holder-signed, with a placeholder proof: for paths that fail before, or stub, the proof check. */
async function presentStub(r: ProofRequest, issuerId = DEMO_CARRIER_ID, contentId = "123456789"): Promise<Presentation> {
  const unsigned = { schema: PRESENTATION_SCHEMA, requestDigest: await requestDigest(r),
    credential: { issuer: issuerId, subject: "supplier:acme", contentId }, holderPublicKey,
    proof: { version: "attest-gpc-v1" } as never } as const;
  return { ...unsigned, holderSignature: POD.sign({ presentation: { type: "string", value: canonicalPresentationBody(unsigned) } }, holderKey).toJSON() };
}
async function enroll(handler: ReturnType<typeof createHandler>, env: Env, over: Partial<EnrollmentStatement> = {},
  opts: { privateKey?: string; token?: string } = {}) {
  const statement: EnrollmentStatement = { schema: ENROLLMENT_SCHEMA, verifier: VERIFIER, subject: user,
    holderPublicKey: deriveSignerPublicKey(opts.privateKey ?? holderKey), issuedAt: NOW - 10_000, ...over };
  const token = opts.token ?? await jwt({ iss: IDP, sub: user.subject, aud: IDP_AUDIENCE, exp: NOW / 1000 + 600, iat: NOW / 1000 - 5 }, idp.privateKey);
  return read(await post(handler, env, "/v1/enrollments",
    { statement, signature: signEnrollment(statement, opts.privateKey ?? holderKey) }, { authorization: `Bearer ${token}` }));
}

beforeAll(async () => {
  [pep, rogue, resultKey, oldResultKey, idp, otherIdp] = await Promise.all([p256(), p256(), p256(), p256(), p256(), p256()]);
  const chainPublic = deriveSignerPublicKey(chainCarrierKey);
  chainEntry = {
    ...cglMin2m, synthetic: false,
    definition: { ...cglMin2m.definition, id: "insurance.cgl.min-2m.chain-test", acceptedIssuers: [{ id: CHAIN_ISSUER, publicKey: chainPublic }] },
    issuers: { [CHAIN_ISSUER]: { authority: "chain", status: "anchor", chainId: 11155111, registry: REGISTRY, account: CHAIN_ACCOUNT,
      scope: (await commitValue(cglMin2m.definition.schema)) as `0x${string}`,
      signingKeyHash: (await commitValue(chainPublic)) as `0x${string}` } },
  };
  catalog = new Map([...defaultCatalog, [chainEntry.definition.id, chainEntry]]);
  defaultDigest = await requirementDigest(cglMin2m.definition);
  chainDigest = await requirementDigest(chainEntry.definition);
});

/* ================================================================ tests */

describe("catalog", () => {
  it("pins the contractor-insurance pack's demo carrier key without bundling its private key", () => {
    expect(deriveSignerPublicKey(DEMO_INSURANCE_ISSUER_PRIVATE_KEY)).toBe(DEMO_CARRIER_PUBLIC_KEY);
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/catalog.ts"), "utf8");
    expect(source).not.toContain(DEMO_INSURANCE_ISSUER_PRIVATE_KEY);
  });
  it("serves the canonical definition and its digest for Gatekeeper to pin", async () => {
    const handler = makeHandler(new FakeChain()), { env } = makeEnv();
    const { status, body } = await read(await get(handler, env, "/v1/requirements/demo.insurance.cgl.min-2m"));
    expect(status).toBe(200);
    expect(body.requirement).toEqual(cglMin2m.definition);
    expect(body.digest).toBe(defaultDigest);
    // Pinned by Gatekeeper and documented in specs/verifier-service.md: changing it is a breaking change.
    expect(defaultDigest).toBe(DEMO_DIGEST);
    expect(body).toMatchObject({ synthetic: true, issuerPolicies: { [DEMO_CARRIER_ID]: { authority: "pinned", status: "issuer-level" } } });
    expect((await get(handler, env, "/v1/requirements/insurance.unknown")).status).toBe(404);
  });
});

describe("configuration", () => {
  it("refuses private key material in pinned PEP keys", async () => {
    expect(() => parseTrustedPeps(JSON.stringify([{ issuer: PEP, keys: [{ kid: "pep-1", publicKey: pep.privateKey }] }])))
      .toThrow(ConfigError);
    const handler = makeHandler(new FakeChain());
    const { env } = makeEnv({ TRUSTED_PEPS: JSON.stringify([{ issuer: PEP, keys: [{ kid: "pep-1", publicKey: pep.privateKey }] }]) });
    const r = baseRequest();
    expect(await read(await post(handler, env, "/v1/presentations", { request: await sign(r), presentation: await presentStub(r) })))
      .toEqual({ status: 503, body: { code: "verifier_misconfigured" } });
    const health = await read(await get(handler, env, "/health"));
    expect(health.status).toBe(503);
    expect(health.body.config).toEqual({ ok: false, code: "verifier_misconfigured" });
  });
  it("refuses a single RPC provider configured twice", async () => {
    const handler = makeHandler(new FakeChain());
    const { env } = makeEnv({ SEPOLIA_RPC_URL_SECONDARY: "https://rpc-a.example/other" });
    expect((await read(await get(handler, env, "/health"))).body.config).toEqual({ ok: false, code: "verifier_misconfigured" });
  });
  it("publishes every configured result public key, and no private member", async () => {
    const { body } = await read(await get(makeHandler(new FakeChain()), makeEnv().env, "/.well-known/jwks.json"));
    const keys = body.keys as JsonWebKey[];
    expect(keys.map((k) => (k as { kid: string }).kid)).toEqual(["verifier-1", "verifier-2"]);
    for (const k of keys) expect(k.d).toBeUndefined();
    expect(keys[1]).toMatchObject({ x: resultKey.publicKey.x, y: resultKey.publicKey.y, alg: "ES256" });
  });
  it("reports revision, verifier id, requirement digests and chain freshness without secrets", async () => {
    const { status, body } = await read(await get(makeHandler(new FakeChain()), makeEnv().env, "/health"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, revision: "rev-test", verifierId: VERIFIER,
      chain: { ok: true, chainId: 11155111, blockNumber: 998, finality: { kind: "confirmations", confirmations: 3 } } });
    expect(body.requirements).toContainEqual({ id: "demo.insurance.cgl.min-2m", digest: defaultDigest, synthetic: true });
    const text = JSON.stringify(body);
    expect(text).not.toContain(resultKey.privateKey.d!);
    expect(text).not.toContain("rpc-a.example");
    const stale = new FakeChain(); stale.headTime -= 3600n;
    const down = await read(await get(makeHandler(stale), makeEnv().env, "/health"));
    expect(down.status).toBe(503);
    expect(down.body.chain).toMatchObject({ ok: false, code: "chain_stale" });
  });
});

describe("holder enrollment", () => {
  it("binds a holder key to the token subject with proof of possession, once", async () => {
    const handler = makeHandler(new FakeChain()), { env, enrollments } = makeEnv();
    expect(await enroll(handler, env)).toMatchObject({ status: 201, body: { enrolled: true, subject: user, holderPublicKey } });
    expect(await enroll(handler, env)).toMatchObject({ status: 200, body: { existing: true } });
    expect([...enrollments.instances.keys()].filter((k) => k.startsWith("holder:"))).toEqual([`holder:${holderPublicKey}`]);
    // The same key cannot then be bound to a second account.
    const mallory: SubjectRef = { issuer: IDP, subject: "user_mallory" };
    const token = await jwt({ iss: IDP, sub: mallory.subject, aud: IDP_AUDIENCE, exp: NOW / 1000 + 600 }, idp.privateKey);
    expect(await enroll(handler, env, { subject: mallory }, { token })).toEqual({ status: 409, body: { code: "holder_already_enrolled" } });
  });

  it.each([
    ["no bearer token", async () => ({ token: "" }), {}, 401, "unauthenticated"],
    ["a token from an unconfigured IdP", async () => ({ token: await jwt({ iss: "https://evil.example", sub: user.subject, aud: IDP_AUDIENCE, exp: NOW / 1000 + 600 }, idp.privateKey) }), {}, 401, "untrusted_token_issuer"],
    ["a token signed by another key", async () => ({ token: await jwt({ iss: IDP, sub: user.subject, aud: IDP_AUDIENCE, exp: NOW / 1000 + 600 }, otherIdp.privateKey) }), {}, 401, "invalid_token_signature"],
    ["a token for another audience", async () => ({ token: await jwt({ iss: IDP, sub: user.subject, aud: "other-app", exp: NOW / 1000 + 600 }, idp.privateKey) }), {}, 401, "token_audience_mismatch"],
    ["an expired token", async () => ({ token: await jwt({ iss: IDP, sub: user.subject, aud: IDP_AUDIENCE, exp: NOW / 1000 - 1 }, idp.privateKey) }), {}, 401, "token_expired"],
    ["a statement naming another subject than the token (forged subject)", async () => ({}), { subject: { issuer: IDP, subject: "user_victim" } }, 403, "enrollment_subject_mismatch"],
    ["a statement naming another IdP for the same sub", async () => ({}), { subject: { issuer: "https://other-idp.example", subject: user.subject } }, 403, "enrollment_subject_mismatch"],
    ["a stale statement", async () => ({}), { issuedAt: NOW - 300_001 }, 400, "enrollment_stale"],
    ["a future-dated statement", async () => ({}), { issuedAt: NOW + 60_000 }, 400, "enrollment_stale"],
    ["a statement for another verifier", async () => ({}), { verifier: "https://other-verifier.example" }, 400, "enrollment_audience_mismatch"],
    ["a statement signed by a key other than the one it enrolls", async () => ({ privateKey: strangerKey }), { holderPublicKey }, 400, "enrollment_signature_invalid"],
  ] as const)("rejects %s", async (_name, opts, over, status, code) => {
    const handler = makeHandler(new FakeChain()), { env, enrollments } = makeEnv();
    const o = await opts();
    const res = "token" in o && o.token === ""
      ? await read(await post(handler, env, "/v1/enrollments", {}))
      : await enroll(handler, env, over as Partial<EnrollmentStatement>, o);
    expect(res).toEqual({ status, body: { code } });
    expect(enrollments.instances.size).toBe(0);
  });
});

describe("presentation verification (pinned issuer, real GPC proofs)", () => {
  let handler: ReturnType<typeof createHandler>, world: ReturnType<typeof makeEnv>;
  let request: ProofRequest, token: string, presentation: Presentation;
  beforeAll(async () => {
    handler = makeHandler(new FakeChain());
    world = makeEnv();
    request = baseRequest();
    token = await sign(request);
    presentation = await prove(request);
  });

  it("refuses a holder key that is not enrolled, without consuming the request; succeeds once enrolled", async () => {
    expect(await read(await post(handler, world.env, "/v1/presentations", { request: token, presentation })))
      .toEqual({ status: 400, body: { code: "holder_not_bound" } });
    expect(consumed(world.replay)).toBe(0);
    expect((await enroll(handler, world.env)).status).toBe(201);
    const ok = await read(await post(handler, world.env, "/v1/presentations", { request: token, presentation }));
    expect(ok.status).toBe(200);
    // Gatekeeper's side: verify with the published key and its own pending-request bindings.
    const jwks = (await read(await get(handler, world.env, "/.well-known/jwks.json"))).body.keys as (JsonWebKey & { kid: string })[];
    const result = await Effect.runPromise(checkVerificationResult(ok.body.result as string, {
      resolveKey: async (issuer, kid) => (issuer === VERIFIER ? jwks.find((k) => k.kid === kid) ?? null : null),
      trustedVerifier: async (issuer, requirement) => issuer === VERIFIER && requirement === "demo.insurance.cgl.min-2m",
      audience: PEP, now: NOW + 1000,
      expected: { requestDigest: await requestDigest(request), subject: user, credentialSubject: "supplier:acme",
        requirement: request.requirement, decisionId: "dec-7" },
    }));
    expect(result).toMatchObject({ issuer: VERIFIER, audience: PEP, credentialIssuer: DEMO_CARRIER_ID,
      status: { source: "issuer-authority", observedAt: NOW }, issuedAt: NOW, expiresAt: NOW + 60_000 });
    // Self-labelled as a demonstration by the signed requirement id.
    expect(result.requirement.id.startsWith("demo.")).toBe(true);
    expect(ok.body.expiresAt).toBe(NOW + 60_000);
    const serialized = JSON.stringify(result);
    for (const secret of [holderPublicKey, presentation.credential.contentId, "5000000"]) expect(serialized).not.toContain(secret);
  });

  it("refuses a replayed request (409) and records it for purge after expiry", async () => {
    expect(await read(await post(handler, world.env, "/v1/presentations", { request: token, presentation })))
      .toEqual({ status: 409, body: { code: "request_replayed" } });
    const record = [...world.replay.instances.values()].find((i) => (i.storage.data.get("request") as { consumed?: unknown })?.consumed);
    expect(record!.storage.alarm).toBe(request.expiresAt + REPLAY_PURGE_SKEW_MS);
    await (record!.object as ReplayStore).alarm();
    expect(record!.storage.data.size).toBe(0);
  });

  it("refuses an enrolled holder presenting for another user's request", async () => {
    const other = baseRequest({ subject: { issuer: IDP, subject: "user_mallory" } });
    // A presentation for this user's request cannot answer mallory's request...
    expect((await read(await post(handler, world.env, "/v1/presentations", { request: await sign(other), presentation }))).body)
      .toEqual({ code: "presentation_request_mismatch" });
    // ...and a fresh, valid proof for mallory's request fails because the key is enrolled to this user.
    expect((await read(await post(handler, world.env, "/v1/presentations",
      { request: await sign(other), presentation: await prove(other) }))).body).toEqual({ code: "holder_not_bound" });
  });
});

describe("request and requirement checks (fail before any proof work)", () => {
  const cases: [string, () => Promise<{ token: string; presentation: unknown }>, number, string][] = [
    ["a request signed by an untrusted key under a trusted kid", async () => {
      const r = baseRequest(); return { token: await sign(r, rogue.privateKey), presentation: await presentStub(r) };
    }, 400, "invalid_signature"],
    ["a request from an unpinned PEP", async () => {
      const r = baseRequest({ issuer: "https://gatekeeper.example/api/attest/tenants/evil" });
      return { token: await sign(r, rogue.privateKey), presentation: await presentStub(r) };
    }, 400, "request_issuer_key_unavailable"],
    ["a request under an unknown kid", async () => {
      const r = baseRequest(); return { token: await sign(r, pep.privateKey, "pep-9"), presentation: await presentStub(r) };
    }, 400, "request_issuer_key_unavailable"],
    ["a request addressed to another verifier", async () => {
      const r = baseRequest({ audience: "https://other-verifier.example" }); return { token: await sign(r), presentation: await presentStub(r) };
    }, 400, "request_audience_mismatch"],
    ["an expired request", async () => {
      const r = baseRequest({ issuedAt: NOW - 300_000, expiresAt: NOW }); return { token: await sign(r), presentation: await presentStub(r) };
    }, 400, "request_expired"],
    ["a requirement digest that does not match the catalog", async () => {
      const r = baseRequest({ requirement: { id: "demo.insurance.cgl.min-2m", digest: "0".repeat(64) } });
      return { token: await sign(r), presentation: await presentStub(r) };
    }, 400, "requirement_mismatch"],
    ["a requirement this verifier does not offer", async () => {
      const r = baseRequest({ requirement: { id: "insurance.cgl.min-1m", digest: defaultDigest } });
      return { token: await sign(r), presentation: await presentStub(r) };
    }, 400, "unknown_requirement"],
    ["a credential about another entity", async () => {
      const r = baseRequest({ credentialSubject: "supplier:globex" }); return { token: await sign(r), presentation: await presentStub(r) };
    }, 400, "credential_subject_mismatch"],
    ["an issuer outside the definition", async () => {
      const r = baseRequest(); return { token: await sign(r), presentation: await presentStub(r, "issuer:unknown") };
    }, 400, "unaccepted_credential_issuer"],
  ];
  it.each(cases)("rejects %s", async (_name, make, status, code) => {
    const { env, replay } = makeEnv();
    const { token, presentation } = await make();
    expect(await read(await post(makeHandler(new FakeChain()), env, "/v1/presentations", { request: token, presentation })))
      .toEqual({ status, body: { code } });
    expect(consumed(replay)).toBe(0);
  });
  it("rejects malformed bodies", async () => {
    const { env } = makeEnv(), handler = makeHandler(new FakeChain());
    expect((await read(await post(handler, env, "/v1/presentations", { request: "x" }))).body).toEqual({ code: "invalid_shape" });
    const res = await handler(new Request("https://v/v1/presentations", { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(415);
    expect((await get(handler, env, "/v1/presentations")).status).toBe(405);
  });
});

describe("chain-anchored issuer (WorkspaceRegistry grant and anchor via ChainStatusReader)", () => {
  const chainRequest = (over: Partial<ProofRequest> = {}) =>
    baseRequest({ requirement: { id: chainEntry.definition.id, digest: chainDigest }, ...over });
  const policy = () => chainEntry.issuers[CHAIN_ISSUER] as Extract<CatalogEntry["issuers"][string], { authority: "chain" }>;
  async function anchor(chain: FakeChain, contentId: string, revoked = false, validUntilSec = NOW / 1000 + 86_400) {
    const p = policy();
    const id = await commitValue({ profile: ANCHOR_PROFILE, schema: chainEntry.definition.schema, contentId });
    chain.anchors.set(id, [p.account, p.scope, (await commitValue(contentId)) as `0x${string}`, BigInt(validUntilSec), revoked]);
  }
  function grant(chain: FakeChain, enabled = true, keyHash = policy().signingKeyHash) {
    chain.grants.set(`${CHAIN_ACCOUNT.toLowerCase()}|${policy().scope}`, [enabled, keyHash]);
  }
  /** Proof checking stubbed: these cases are about authority and status, and run after a valid holder signature. */
  const stubbed = (chain: FakeChain) => makeHandler(chain, { verifyProof: async () => true });
  async function attempt(chain: FakeChain, handler = stubbed(chain), contentId = "424242") {
    const { env, replay } = makeEnv();
    expect((await enroll(handler, env)).status).toBe(201);
    const r = chainRequest();
    const res = await read(await post(handler, env, "/v1/presentations",
      { request: await sign(r), presentation: await presentStub(r, CHAIN_ISSUER, contentId) }));
    return { ...res, consumed: consumed(replay) };
  }

  it("issues a result with chain evidence for a real proof when grant and anchor are active at the settled block", async () => {
    const chain = new FakeChain(); grant(chain);
    const handler = makeHandler(chain), { env } = makeEnv();
    expect((await enroll(handler, env)).status).toBe(201);
    const r = chainRequest();
    const presentation = await prove(r, chainEntry, chainCarrierKey, CHAIN_ISSUER);
    await anchor(chain, presentation.credential.contentId);
    const { status, body } = await read(await post(handler, env, "/v1/presentations", { request: await sign(r), presentation }));
    expect(status).toBe(200);
    const payload = JSON.parse(Buffer.from((body.result as string).split(".")[1]!, "base64url").toString());
    expect(payload.status).toEqual({ source: "chain", observedAt: NOW, chainId: 11155111, blockNumber: 998,
      blockHash: `0x${(998).toString(16).padStart(64, "a")}` });
  });

  it("rejects an issuer whose on-chain grant is withdrawn or whose signing key was rotated", async () => {
    const off = new FakeChain(); grant(off, false); await anchor(off, "424242");
    expect(await attempt(off)).toEqual({ status: 400, body: { code: "unauthorized_credential_issuer" }, consumed: 0 });
    const rotated = new FakeChain(); grant(rotated, true, `0x${"9".repeat(64)}`); await anchor(rotated, "424242");
    expect(await attempt(rotated)).toEqual({ status: 400, body: { code: "unauthorized_credential_issuer" }, consumed: 0 });
  });

  it("rejects a revoked or expired credential anchor", async () => {
    const revoked = new FakeChain(); grant(revoked); await anchor(revoked, "424242", true);
    expect(await attempt(revoked)).toEqual({ status: 400, body: { code: "credential_not_active" }, consumed: 0 });
    const expired = new FakeChain(); grant(expired); await anchor(expired, "424242", false, NOW / 1000 - 3600);
    expect(await attempt(expired)).toEqual({ status: 400, body: { code: "credential_not_active" }, consumed: 0 });
  });

  it("answers 503 for a credential not (yet) anchored at the settled block", async () => {
    const chain = new FakeChain(); grant(chain);
    expect(await attempt(chain)).toEqual({ status: 503, body: { code: "status_unavailable" }, consumed: 0 });
  });

  it("answers 503 for stale or inconsistent chain status, never a result", async () => {
    const stale = new FakeChain(); grant(stale); await anchor(stale, "424242"); stale.headTime -= 3600n;
    expect(await attempt(stale)).toEqual({ status: 503, body: { code: "chain_unavailable" }, consumed: 0 });
    // The secondary RPC reports a revoked anchor: the providers disagree, so the verifier fails closed.
    const a = new FakeChain(), b = new FakeChain();
    for (const c of [a, b]) { grant(c); await anchor(c, "424242", c === b); }
    const split = makeHandler(a, { verifyProof: async () => true, endpoints: () => [a.endpoint("primary"), b.endpoint("secondary")] });
    expect(await attempt(a, split)).toEqual({ status: 503, body: { code: "chain_unavailable" }, consumed: 0 });
    const wrongChain = new FakeChain(); grant(wrongChain); await anchor(wrongChain, "424242"); wrongChain.chainId = 1;
    expect(await attempt(wrongChain)).toEqual({ status: 503, body: { code: "chain_unavailable" }, consumed: 0 });
  });

  it("rejects a proof that does not verify", async () => {
    const chain = new FakeChain(); grant(chain); await anchor(chain, "424242");
    expect(await attempt(chain, makeHandler(chain, { verifyProof: async () => false })))
      .toEqual({ status: 400, body: { code: "proof_invalid" }, consumed: 0 });
  });
});

/* ================================================================ security review (ATTE-28) */

const keyAliases = () => {
  const hex = encodePublicKey(decodePublicKey(holderPublicKey), "hex");
  return { hex, upperHex: hex.toUpperCase(), mixedHex: hex.slice(0, 20).toUpperCase() + hex.slice(20), padded: holderPublicKey + "=" };
};

describe("H1: one holder key, one spelling", () => {
  it.each(["hex", "upperHex", "mixedHex", "padded"] as const)("refuses to enroll a %s-encoded holder key", async (form) => {
    const handler = makeHandler(new FakeChain()), { env, enrollments } = makeEnv();
    const alias = keyAliases()[form];
    expect(canonicalPublicKey(alias)).toBe(holderPublicKey);
    expect(await enroll(handler, env, { holderPublicKey: alias })).toEqual({ status: 400, body: { code: "noncanonical_holder_key" } });
    expect(enrollments.instances.size).toBe(0);
  });
  it("cannot bind an alias of an enrolled key to a second subject", async () => {
    const handler = makeHandler(new FakeChain()), { env, enrollments } = makeEnv();
    expect((await enroll(handler, env)).status).toBe(201);
    const token = await jwt({ iss: IDP, sub: "user_mallory", aud: IDP_AUDIENCE, exp: NOW / 1000 + 600 }, idp.privateKey);
    for (const alias of Object.values(keyAliases()))
      expect((await enroll(handler, env, { subject: { issuer: IDP, subject: "user_mallory" }, holderPublicKey: alias }, { token })).body)
        .toEqual({ code: "noncanonical_holder_key" });
    expect([...enrollments.instances.keys()].filter((k) => k.startsWith("holder:"))).toEqual([`holder:${holderPublicKey}`]);
  });
  it("refuses a presentation whose holder key is not canonical", async () => {
    const { env } = makeEnv(), r = baseRequest();
    const p = { ...(await presentStub(r)), holderPublicKey: keyAliases().hex };
    expect((await read(await post(makeHandler(new FakeChain()), env, "/v1/presentations", { request: await sign(r), presentation: p }))).body)
      .toEqual({ code: "noncanonical_holder_key" });
  });
});

describe("H2 and catalog assertions", () => {
  const broken = async (mutate: (e: CatalogEntry) => CatalogEntry) => {
    const entry = mutate(structuredClone(chainEntry));
    const handler = makeHandler(new FakeChain(), { catalog: new Map([[entry.definition.id, entry]]) });
    return (await read(await get(handler, makeEnv().env, "/health"))).body.config;
  };
  const chainPolicy = (e: CatalogEntry) => e.issuers[CHAIN_ISSUER] as Extract<CatalogEntry["issuers"][string], { authority: "chain" }>;
  it("labels the demo requirement and pins its new digest", () => {
    expect(cglMin2m.definition.id).toBe("demo.insurance.cgl.min-2m");
    expect(cglMin2m.synthetic).toBe(true);
  });
  it.each([
    ["a synthetic requirement without the demo. prefix", (e: CatalogEntry) => ({ ...e, synthetic: true })],
    ["a demo. requirement not marked synthetic", (e: CatalogEntry) => {
      const id = "demo." + e.definition.id; return { ...e, definition: { ...e.definition, id } };
    }],
    ["a chain policy whose signing-key commitment is not the accepted key's", (e: CatalogEntry) => {
      chainPolicy(e).signingKeyHash = `0x${"9".repeat(64)}`; return e;
    }],
    ["a chain policy on another chain", (e: CatalogEntry) => { chainPolicy(e).chainId = 1; return e; }],
    ["a chain policy whose scope is not the schema's", (e: CatalogEntry) => { chainPolicy(e).scope = `0x${"8".repeat(64)}`; return e; }],
  ] as const)("refuses %s", async (_name, mutate) => {
    expect(await broken(mutate)).toEqual({ ok: false, code: "verifier_misconfigured" });
  });
});

describe("M2: body limits", () => {
  const raw = (body: BodyInit, headers: Record<string, string>) =>
    makeHandler(new FakeChain())(new Request("https://v/v1/presentations", {
      method: "POST", body, headers: { "content-type": "application/json", ...headers }, ...({ duplex: "half" } as object),
    }), makeEnv().env);
  it("requires a Content-Length", async () => {
    expect(await read(await raw("{}", {}))).toEqual({ status: 411, body: { code: "length_required" } });
  });
  it("refuses a declared length over the limit before reading", async () => {
    expect(await read(await raw("{}", { "content-length": String(MAX_BODY_BYTES + 1) })))
      .toEqual({ status: 413, body: { code: "payload_too_large" } });
  });
  it("counts streamed bytes and aborts past the limit even when the declared length lies", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; if (pulled > 100) controller.close(); else controller.enqueue(chunk); },
    });
    expect(await read(await raw(stream, { "content-length": "10" }))).toEqual({ status: 413, body: { code: "payload_too_large" } });
    expect(pulled).toBeLessThan(20);
  });
});

describe("ATTE-20 M3: bounded, expiring enrollment", () => {
  const keyFor = (n: number) => (n + 0x60).toString(16).padStart(2, "0").repeat(32);
  it("caps active holder keys per subject, and frees a slot when a binding fails", async () => {
    const handler = makeHandler(new FakeChain()), { env } = makeEnv();
    for (let i = 0; i < MAX_KEYS_PER_SUBJECT; i++)
      expect((await enroll(handler, env, {}, { privateKey: keyFor(i) })).status).toBe(201);
    // Re-enrolling an existing key is still fine; a sixth key is refused.
    expect((await enroll(handler, env, {}, { privateKey: keyFor(0) })).status).toBe(200);
    expect(await enroll(handler, env, {}, { privateKey: keyFor(9) })).toEqual({ status: 409, body: { code: "too_many_holder_keys" } });
    // Another subject trying to take one of those keys is refused without consuming a slot.
    const mallory = "user_mallory";
    const token = await jwt({ iss: IDP, sub: mallory, aud: IDP_AUDIENCE, exp: NOW / 1000 + 600 }, idp.privateKey);
    for (let i = 0; i < 3; i++)
      expect((await enroll(handler, env, { subject: { issuer: IDP, subject: mallory } }, { privateKey: keyFor(i), token })).status).toBe(409);
    expect((await enroll(handler, env, { subject: { issuer: IDP, subject: mallory } }, { privateKey: keyFor(8), token })).status).toBe(201);
  });
  it("expires bindings from an IdP with bindingTtlMs, then lets the key rebind; an alarm deletes them", async () => {
    const providers = JSON.stringify([{ issuer: IDP, jwksUri: "https://login.acme.example/jwks", audience: IDP_AUDIENCE, bindingTtlMs: 3_600_000 }]);
    const handler = makeHandler(new FakeChain()), { env, enrollments } = makeEnv({ IDENTITY_PROVIDERS: providers });
    const first = await enroll(handler, env);
    expect(first).toMatchObject({ status: 201, body: { expiresAt: NOW + 3_600_000 } });
    const holder = enrollments.instances.get(`holder:${holderPublicKey}`)!;
    expect(holder.storage.alarm).toBe(NOW + 3_600_000);
    // Bound before expiry; unbound (and rebindable by someone else) after it.
    const stub = (now: number) => env.ENROLLMENTS.get(env.ENROLLMENTS.idFromName(`holder:${holderPublicKey}`))
      .fetch(`https://enrollments/binding?now=${now}`, { method: "GET" }).then((r) => r.json());
    expect(await stub(NOW + 3_599_999)).toMatchObject({ binding: { subject: user.subject } });
    expect(await stub(NOW + 3_600_000)).toEqual({ binding: null });
    clock = NOW + 3_600_001;
    try {
      const mallory = "user_mallory";
      const token = await jwt({ iss: IDP, sub: mallory, aud: IDP_AUDIENCE, exp: Math.floor(clock / 1000) + 600, iat: Math.floor(clock / 1000) }, idp.privateKey);
      expect((await enroll(handler, env, { subject: { issuer: IDP, subject: mallory }, issuedAt: clock - 1000 }, { token })).status).toBe(201);
    } finally {
      clock = NOW;
    }
    // The alarm deletes an expired binding outright.
    const storage = new MemoryStorage();
    const store = new EnrollmentStore({ storage });
    await store.fetch(new Request("https://enrollments/binding", { method: "PUT",
      body: JSON.stringify({ issuer: IDP, subject: "s", enrolledAt: 1, expiresAt: 2 }) }));
    await store.alarm();
    expect(storage.data.size).toBe(0);
    expect(() => parseIdentityProviders(JSON.stringify([{ issuer: IDP, jwksUri: "https://x.example/j", audience: "a", bindingTtlMs: 10 }])))
      .toThrow(ConfigError);
  });
  it("rate-limits enrollment per client IP before verifying the token", async () => {
    const seen: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: seen.length <= 1 }; } };
    const handler = makeHandler(new FakeChain()), { env } = makeEnv({ ENROLLMENT_RATE_LIMITER: limiter });
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    const statement = { schema: ENROLLMENT_SCHEMA, verifier: VERIFIER, subject: user, holderPublicKey, issuedAt: NOW - 10_000 };
    const token = await jwt({ iss: IDP, sub: user.subject, aud: IDP_AUDIENCE, exp: NOW / 1000 + 600 }, idp.privateKey);
    const body = { statement, signature: signEnrollment(statement as EnrollmentStatement, holderKey) };
    expect((await post(handler, env, "/v1/enrollments", body, { authorization: `Bearer ${token}`, ...ip })).status).toBe(201);
    expect(await read(await post(handler, env, "/v1/enrollments", body, { authorization: `Bearer ${token}`, ...ip })))
      .toEqual({ status: 429, body: { code: "rate_limited" } });
    expect(seen).toEqual(["enroll:203.0.113.7", "enroll:203.0.113.7"]);
  });
});

describe("L1: concurrent enrollment of one key", () => {
  it("binds the key to exactly one of two racing subjects", async () => {
    const storage = new MemoryStorage(); storage.latencyMs = 5;
    const store = new EnrollmentStore({ storage });
    const put = (subject: string) => store.fetch(new Request("https://enrollments/binding", {
      method: "PUT", body: JSON.stringify({ issuer: IDP, subject, enrolledAt: NOW }),
    }));
    const statuses = (await Promise.all([put("user_a"), put("user_b"), put("user_c")])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
  });
});

describe("L2: access token type and client", () => {
  const claims = () => ({ iss: IDP, sub: user.subject, aud: IDP_AUDIENCE, exp: NOW / 1000 + 600, client_id: "gatekeeper-web" });
  it.each([["JWT"], ["id+jwt"], [null]] as const)("refuses typ %s by default", async (typ) => {
    const token = await jwt(claims(), idp.privateKey, "idp-1", typ);
    expect(await enroll(makeHandler(new FakeChain()), makeEnv().env, {}, { token }))
      .toEqual({ status: 401, body: { code: "unsupported_token_type" } });
  });
  it("accepts an explicitly allowed typ, and enforces a pinned client id", async () => {
    const idps = (over: object) => JSON.stringify([{ issuer: IDP, jwksUri: "https://login.acme.example/jwks", audience: IDP_AUDIENCE, ...over }]);
    const plain = await jwt(claims(), idp.privateKey, "idp-1", "JWT");
    expect((await enroll(makeHandler(new FakeChain()), makeEnv({ IDENTITY_PROVIDERS: idps({ allowedTyp: ["JWT"] }) }).env, {}, { token: plain })).status).toBe(201);
    const token = await jwt(claims(), idp.privateKey);
    expect((await enroll(makeHandler(new FakeChain()), makeEnv({ IDENTITY_PROVIDERS: idps({ clientId: "gatekeeper-web" }) }).env, {}, { token })).status).toBe(201);
    expect(await enroll(makeHandler(new FakeChain()), makeEnv({ IDENTITY_PROVIDERS: idps({ clientId: "other-client" }) }).env, {}, { token }))
      .toEqual({ status: 401, body: { code: "token_client_mismatch" } });
  });
});

describe("L4 and L5: configuration probes", () => {
  it("refuses a result key whose private half does not match its public half, before consuming anything", async () => {
    const mismatched = { ...resultKey.privateKey, d: oldResultKey.privateKey.d };
    const { env, replay, enrollments } = makeEnv({ RESULT_SIGNING_KEYS: JSON.stringify({ active: "k", keys: [{ kid: "k", privateKey: mismatched }] }) });
    const r = baseRequest();
    expect(await read(await post(makeHandler(new FakeChain()), env, "/v1/presentations", { request: await sign(r), presentation: await presentStub(r) })))
      .toEqual({ status: 503, body: { code: "verifier_misconfigured" } });
    expect(replay.instances.size + enrollments.instances.size).toBe(0);
  });
  it("requires https RPC URLs except for explicitly local hosts", async () => {
    const health = async (over: Partial<Env>) => (await read(await get(makeHandler(new FakeChain()), makeEnv(over).env, "/health"))).body;
    expect((await health({ SEPOLIA_RPC_URL: "http://rpc-a.example" })).config).toEqual({ ok: false, code: "verifier_misconfigured" });
    expect((await health({ SEPOLIA_RPC_URL: "http://127.0.0.1:8545", SEPOLIA_RPC_URL_SECONDARY: "http://localhost:8546" })).ok).toBe(true);
    expect(() => rpcUrl("ftp://rpc.example", "X")).toThrow(ConfigError);
  });
});

describe("L6: IdP key fetch", () => {
  const ok = () => new Response(JSON.stringify({ keys: [{ kty: "EC", kid: "idp-1" }] }), { status: 200 });
  it("times out a hanging JWKS endpoint", async () => {
    const hanging = ((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    await expect(defaultJwksFetcher({ fetch: hanging, timeoutMs: 20 })("https://idp/jwks")).rejects.toMatchObject({ code: "idp_keys_unavailable" });
  });
  it("caps the response size, including when the length is not declared", async () => {
    const big = (() => Promise.resolve(new Response("x".repeat(70_000), { status: 200 }))) as unknown as typeof fetch;
    await expect(defaultJwksFetcher({ fetch: big })("https://idp/jwks")).rejects.toMatchObject({ code: "idp_keys_unavailable" });
  });
  it("caches failures briefly and successes longer", async () => {
    let calls = 0, t = 0, fail = true;
    const f = (async () => { calls++; return fail ? new Response("", { status: 500 }) : ok(); }) as unknown as typeof fetch;
    const fetcher = defaultJwksFetcher({ fetch: f, now: () => t });
    await expect(fetcher("https://idp/jwks")).rejects.toMatchObject({ code: "idp_keys_unavailable" });
    await expect(fetcher("https://idp/jwks")).rejects.toMatchObject({ code: "idp_keys_unavailable" });
    expect(calls).toBe(1);
    fail = false; t += JWKS_FAILURE_TTL_MS;
    expect((await fetcher("https://idp/jwks")).keys).toHaveLength(1);
    t += 1000;
    await fetcher("https://idp/jwks");
    expect(calls).toBe(2);
  });
});

describe("L3 and L7: replay records and attempt budget", () => {
  const chainRequest = (over: Partial<ProofRequest> = {}) =>
    baseRequest({ requirement: { id: chainEntry.definition.id, digest: chainDigest }, ...over });
  const policy = () => chainEntry.issuers[CHAIN_ISSUER] as Extract<CatalogEntry["issuers"][string], { authority: "chain" }>;
  async function activeChain(enabled = true) {
    const chain = new FakeChain(), p = policy();
    chain.grants.set(`${CHAIN_ACCOUNT.toLowerCase()}|${p.scope}`, [enabled, p.signingKeyHash]);
    const id = await commitValue({ profile: ANCHOR_PROFILE, schema: chainEntry.definition.schema, contentId: "424242" });
    chain.anchors.set(id, [p.account, p.scope, (await commitValue("424242")) as `0x${string}`, BigInt(NOW / 1000 + 86_400), false]);
    return chain;
  }

  it("names replay records from the verified PEP issuer, so two PEPs may reuse a request id", async () => {
    const PEP2 = "https://gatekeeper.example/api/attest/tenants/globex";
    const chain = await activeChain(), handler = makeHandler(chain, { verifyProof: async () => true });
    const { env, replay } = makeEnv({ TRUSTED_PEPS: JSON.stringify([
      { issuer: PEP, keys: [{ kid: "pep-1", publicKey: pep.publicKey }] },
      { issuer: PEP2, keys: [{ kid: "pep-1", publicKey: rogue.publicKey }] }]) });
    expect((await enroll(handler, env)).status).toBe(201);
    const a = chainRequest({ id: "req-shared" }), b = chainRequest({ id: "req-shared", issuer: PEP2 });
    for (const [r, key] of [[a, pep.privateKey], [b, rogue.privateKey]] as const)
      expect((await post(handler, env, "/v1/presentations", { request: await sign(r, key), presentation: await presentStub(r, CHAIN_ISSUER, "424242") })).status).toBe(200);
    expect(consumed(replay)).toBe(2);
    expect([...replay.instances.keys()].sort()).toEqual([await replayName(PEP, "req-shared"), await replayName(PEP2, "req-shared")].sort());
  });

  it(`refuses a request after ${MAX_FAILED_ATTEMPTS} failed attempts with 429, before chain or proof work`, async () => {
    const chain = await activeChain(false);
    const handler = makeHandler(chain, { verifyProof: async () => true });
    const { env } = makeEnv();
    expect((await enroll(handler, env)).status).toBe(201);
    const r = chainRequest(), body = { request: await sign(r), presentation: await presentStub(r, CHAIN_ISSUER, "424242") };
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
      expect((await read(await post(handler, env, "/v1/presentations", body))).body).toEqual({ code: "unauthorized_credential_issuer" });
    // The grant is restored, but this request's budget is spent.
    const p = policy(); chain.grants.set(`${CHAIN_ACCOUNT.toLowerCase()}|${p.scope}`, [true, p.signingKeyHash]);
    const before = chain.snapshots;
    expect(await read(await post(handler, env, "/v1/presentations", body))).toEqual({ status: 429, body: { code: "attempts_exhausted" } });
    expect(chain.snapshots).toBe(before);
    // Unsigned or untrusted junk never spends a legitimate request's budget.
    const fresh = chainRequest();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i++)
      await post(handler, env, "/v1/presentations", { request: await sign(fresh, rogue.privateKey), presentation: await presentStub(fresh, CHAIN_ISSUER, "424242") });
    expect((await post(handler, env, "/v1/presentations", { request: await sign(fresh), presentation: await presentStub(fresh, CHAIN_ISSUER, "424242") })).status).toBe(200);
  });

  it("caches the /health chain snapshot for about 20 s", async () => {
    const chain = new FakeChain(), handler = makeHandler(chain), { env } = makeEnv();
    try {
      await get(handler, env, "/health"); await get(handler, env, "/health");
      expect(chain.snapshots).toBe(1);
      clock = NOW + HEALTH_CACHE_MS - 1; await get(handler, env, "/health");
      expect(chain.snapshots).toBe(1);
      clock = NOW + HEALTH_CACHE_MS; chain.headTime += BigInt(HEALTH_CACHE_MS / 1000);
      await get(handler, env, "/health");
      expect(chain.snapshots).toBe(2);
    } finally {
      clock = NOW;
    }
  });
});
