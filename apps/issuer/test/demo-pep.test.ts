import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyDecisionReceipt, DEMO_PEP_LEDGER_PROFILE, type DecisionReceipt } from "@attest/chain-evm";
import {
  requestDigest, signVerificationResult, verifyProofRequest, VERIFICATION_RESULT_SCHEMA,
  type ProofRequest, type VerificationResult,
} from "@attest/verifier";
import { verifyAccessToken } from "../../verifier/src/idp";
import { parseIdentityProviders } from "../../verifier/src/config";
import { cglMin2m } from "../../verifier/src/catalog";
import { requirementDigest } from "@attest/verifier";
import { createDemoPep, DAILY_TOKENS, MAX_PENDING_PER_PRINCIPAL } from "../src/demo-pep/pep";
import type { DemoPepEnv } from "../src/demo-pep/config";
import { appendDecision, decisionReceipt, sealEpoch, type LedgerDecision } from "../src/demo-pep/ledger";
import { MemoryStore } from "./memory-store";

const NOW = 1_795_300_000_000;
const PEP = "https://attest.example/api/demo-pep";
const IDENTITY = `${PEP}/identity`;
const VERIFIER = "https://verify.attest.example";
const DIGEST = "2251414534a86a6cbe9b53d6a030b6fbe4437f8d1e7341ec0bc91246846b3d20";
const REQ = "demo.insurance.cgl.min-2m";

type Pair = { privateKey: JsonWebKey; publicKey: JsonWebKey };
async function p256(): Promise<Pair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    privateKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! },
    publicKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
  };
}
const keySet = (kid: string, p: Pair) => JSON.stringify({ active: kid, keys: [{ kid, privateKey: p.privateKey }] });


let pepKey: Pair, idKey: Pair, verifierKey: Pair, rogue: Pair;
let clock = NOW;
let store: MemoryStore;
let env: DemoPepEnv;
let handle: ReturnType<typeof createDemoPep>;

const verifierPin = (over: Record<string, unknown> = {}) => JSON.stringify({
  issuer: VERIFIER, endpoint: `${VERIFIER}/v1/presentations`,
  keys: [{ kid: "verifier-1", publicKey: verifierKey.publicKey }],
  requirements: [{ id: REQ, digest: DIGEST }], ...over,
});
const makeEnv = (over: Partial<DemoPepEnv> = {}): DemoPepEnv => ({
  DEMO_PEP_ISSUER: PEP, DEMO_PEP_VERIFIER: verifierPin(),
  DEMO_PEP_SIGNING_KEY: keySet("pep-1", pepKey), DEMO_IDENTITY_SIGNING_KEY: keySet("id-1", idKey), ...over,
});

const req = (pathName: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
  const text = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Request(`https://attest.example${pathName}`, {
    method: init.method ?? (text === undefined ? "GET" : "POST"),
    headers: {
      ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(text === undefined ? {} : { body: text }),
  });
};
const send = async (pathName: string, init: Parameters<typeof req>[1] = {}, e = env) => {
  const res = await handle(req(pathName, init), e, store);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const signIn = async () => {
  const { status, body } = await send("/api/demo-pep/identity/token", { method: "POST", body: {} });
  expect(status).toBe(201);
  return body as { access_token: string; subject: { issuer: string; subject: string } };
};
const ask = (token: string, attest?: unknown, over: Record<string, unknown> = {}) =>
  send("/api/demo-pep/authorize", { token, body: {
    action: "vendor.payout.approve", resourceId: "supplier:acme", ...(attest === undefined ? {} : { attest }), ...over,
  } });
async function challenge(token: string) {
  const { status, body } = await ask(token);
  expect(status).toBe(200);
  expect(body.outcome).toBe("challenge");
  const c = body.attest.requests[0];
  const { request } = await verifyProofRequest(c.request, {
    resolveKey: async (_i, kid) => (kid === "pep-1" ? pepKey.publicKey : null), audience: VERIFIER, now: clock,
  });
  return { challenge: c, request, decisionId: body.decisionId as string };
}
/** What the verifier would sign for `request` (no GPC here; the e2e test runs the real verifier). */
async function resultFor(request: ProofRequest, over: Partial<VerificationResult> = {}, key = verifierKey.privateKey, kid = "verifier-1") {
  const result: VerificationResult = {
    schema: VERIFICATION_RESULT_SCHEMA, id: `res-${crypto.randomUUID()}`, issuer: VERIFIER, audience: PEP,
    requestId: request.id, requestDigest: await requestDigest(request),
    ...(request.decisionId ? { decisionId: request.decisionId } : {}),
    subject: request.subject, credentialSubject: request.credentialSubject, requirement: request.requirement,
    credentialIssuer: "issuer:carrier", status: { source: "issuer-authority", observedAt: clock },
    issuedAt: clock, expiresAt: clock + 60_000, ...over,
  };
  return signVerificationResult(result, kid, key);
}

beforeAll(async () => {
  [pepKey, idKey, verifierKey, rogue] = await Promise.all([p256(), p256(), p256(), p256()]);
});
beforeEach(() => {
  clock = NOW;
  store = new MemoryStore();
  env = makeEnv();
  handle = createDemoPep({ now: () => clock, fetchJwks: async () => { throw new Error("no external IdP in tests"); } });
});

describe("demo PEP configuration", () => {
  it("pins the verifier catalog's digest for demo.insurance.cgl.min-2m", async () => {
    expect(await requirementDigest(cglMin2m.definition)).toBe(DIGEST);
    const root = (await import("node:fs")).readFileSync(path.resolve(import.meta.dirname, "../../../wrangler.jsonc"), "utf8");
    expect(root).toContain(DIGEST);
  });
  it("fails closed on private key material in the pinned verifier keys", async () => {
    const bad = makeEnv({ DEMO_PEP_VERIFIER: verifierPin({ keys: [{ kid: "v", publicKey: verifierKey.privateKey }] }) });
    expect(await send("/api/demo-pep/jwks", {}, bad)).toEqual({ status: 503, body: { code: "demo_pep_misconfigured" } });
  });
  it("fails closed without signing secrets, and refuses one key for both roles", async () => {
    const { DEMO_PEP_SIGNING_KEY: _, ...missing } = makeEnv();
    expect((await send("/api/demo-pep/jwks", {}, missing)).status).toBe(503);
    expect((await send("/api/demo-pep/jwks", {}, makeEnv({ DEMO_IDENTITY_SIGNING_KEY: keySet("id-1", pepKey) }))).status).toBe(503);
  });
  it("publishes public keys only", async () => {
    const { body } = await send("/api/demo-pep/jwks");
    expect(body.keys).toEqual([{ ...pepKey.publicKey, kid: "pep-1", alg: "ES256", use: "sig" }]);
    const id = await send("/api/demo-pep/identity/jwks");
    expect(id.body.keys[0].d).toBeUndefined();
    const discovery = await send("/api/demo-pep");
    expect(discovery.body).toMatchObject({ standIn: "gatekeeper", issuer: PEP, policy: { requirementId: REQ } });
    expect(JSON.stringify(discovery.body)).not.toContain(pepKey.privateKey.d!);
  });
});

describe("demo identity", () => {
  it("mints an RFC 9068 access token the verifier's IdP check accepts for both audiences", async () => {
    const { access_token, subject } = await signIn();
    expect(subject.issuer).toBe(IDENTITY);
    expect(subject.subject).toMatch(/^demo-/);
    const jwks = (await send("/api/demo-pep/identity/jwks")).body as { keys: JsonWebKey[] };
    const providers = parseIdentityProviders(JSON.stringify([{ issuer: IDENTITY, jwksUri: `${IDENTITY}/jwks`, audience: VERIFIER }]));
    const verified = await verifyAccessToken(access_token, providers, async () => jwks, clock);
    expect(verified.subject).toEqual(subject);
    // A token from another issuer is not accepted by the PEP.
    const foreign = parseIdentityProviders(JSON.stringify([{ issuer: "https://other.example", jwksUri: "https://other.example/jwks", audience: PEP }]));
    await expect(verifyAccessToken(access_token, foreign, async () => jwks, clock)).rejects.toThrow("untrusted_token_issuer");
  });
  it("refuses unauthenticated and expired callers", async () => {
    expect((await ask("")).status).toBe(401);
    const { access_token } = await signIn();
    clock += 16 * 60_000;
    expect((await ask(access_token)).body).toEqual({ code: "token_expired" });
  });
  it("caps daily tokens", async () => {
    await store.put(`quota:${new Date(NOW).toISOString().slice(0, 10)}:tokens`, DAILY_TOKENS);
    expect((await send("/api/demo-pep/identity/token", { method: "POST", body: {} })).status).toBe(429);
  });
});

describe("demo PEP challenge → result → allow", () => {
  it("challenges with a signed request bound to the caller, entity, pinned requirement and decision", async () => {
    const { access_token, subject } = await signIn();
    const { challenge: c, request, decisionId } = await challenge(access_token);
    expect(request).toMatchObject({
      issuer: PEP, audience: VERIFIER, subject, credentialSubject: "supplier:acme",
      requirement: { id: REQ, digest: DIGEST }, decisionId, expiresAt: clock + 300_000,
    });
    expect(c).toMatchObject({ requestId: request.id, verifier: VERIFIER, endpoint: `${VERIFIER}/v1/presentations` });
    // A repeated challenge re-sends the outstanding request.
    expect((await challenge(access_token)).request.id).toBe(request.id);
  });
  it("allows on a valid result, consumes it once and keeps the fact until it expires", async () => {
    const { access_token } = await signIn();
    const { request } = await challenge(access_token);
    const result = await resultFor(request);
    const allowed = await ask(access_token, { requestId: request.id, result });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ outcome: "allow", reason: "policy_satisfied",
      evidence: [{ verifier: VERIFIER, requirement: { id: REQ, digest: DIGEST }, statusSource: "issuer-authority" }] });
    // Replayed result: refused, never a second consume.
    expect((await ask(access_token, { requestId: request.id, result })).body)
      .toEqual({ code: "InvalidAttestResult", message: "request_consumed" });
    // Without a result the fact still holds until the result's expiry, then the PEP challenges again.
    expect((await ask(access_token)).body.outcome).toBe("allow");
    clock += 61_000;
    expect((await ask(access_token)).body.outcome).toBe("challenge");
  });
  it("denies actions outside the demo policy", async () => {
    const { access_token } = await signIn();
    expect((await ask(access_token, undefined, { resourceId: "supplier:globex" })).body)
      .toMatchObject({ outcome: "deny", reason: "no_matching_policy" });
  });
  it("caps pending requests per principal", async () => {
    const { access_token } = await signIn();
    const { request } = await challenge(access_token);
    // Age the request past the reuse window so each challenge mints a new one.
    for (let i = 1; i < MAX_PENDING_PER_PRINCIPAL; i++) {
      await store.put(`req:${request.id}`, { ...(await store.get<any>(`req:${request.id}`)), expiresAt: clock + 30_000 });
      clock += 1;
      const next = await challenge(access_token);
      request.id = next.request.id;
    }
    await store.put(`req:${request.id}`, { ...(await store.get<any>(`req:${request.id}`)), expiresAt: clock + 30_000 });
    const { body } = await ask(access_token);
    expect(body.attest).toEqual({ requests: [], error: "attest_too_many_pending" });
  });
});

describe("demo PEP negative joins", () => {
  const refused = (code: string) => ({ status: 400, body: { code: "InvalidAttestResult", message: code } });
  it("refuses a result for another request", async () => {
    const alice = await signIn(), bob = await signIn();
    const a = await challenge(alice.access_token), b = await challenge(bob.access_token);
    // Bob's result relayed under Alice's request id: bound to Bob's request digest and subject.
    expect(await ask(alice.access_token, { requestId: a.request.id, result: await resultFor(b.request) }))
      .toEqual(refused("result_binding_mismatch"));
    // Alice cannot answer (or probe) Bob's request at all.
    expect(await ask(alice.access_token, { requestId: b.request.id, result: await resultFor(b.request) }))
      .toEqual(refused("unknown_request"));
    // Same digest but another request id.
    expect(await ask(alice.access_token, { requestId: a.request.id, result: await resultFor(a.request, { requestId: "req_other" }) }))
      .toEqual(refused("result_binding_mismatch"));
  });
  it("refuses a result about another subject or another entity", async () => {
    const { access_token } = await signIn();
    const { request } = await challenge(access_token);
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request, { subject: { issuer: IDENTITY, subject: "demo-mallory" } }) }))
      .toEqual(refused("result_binding_mismatch"));
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request, { credentialSubject: "supplier:globex" }) }))
      .toEqual(refused("result_binding_mismatch"));
  });
  it("refuses a wrong requirement digest, and a request whose pin changed", async () => {
    const { access_token } = await signIn();
    const { request } = await challenge(access_token);
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request, { requirement: { id: REQ, digest: "0".repeat(64) } }) }))
      .toEqual(refused("result_binding_mismatch"));
    const repinned = makeEnv({ DEMO_PEP_VERIFIER: verifierPin({ requirements: [{ id: REQ, digest: "1".repeat(64) }] }) });
    const res = await handle(req("/api/demo-pep/authorize", { token: access_token, body: {
      action: "vendor.payout.approve", resourceId: "supplier:acme", attest: { requestId: request.id, result: await resultFor(request) } } }), repinned, store);
    expect(await res.json()).toEqual(refused("untrusted_verifier").body);
  });
  it("refuses expired results and expired requests", async () => {
    const { access_token } = await signIn();
    const { request } = await challenge(access_token);
    const result = await resultFor(request, { expiresAt: clock + 10_000 });
    clock += 10_000;
    expect(await ask(access_token, { requestId: request.id, result })).toEqual(refused("result_expired"));
    // An expired request is purged before results are read, so it is simply unknown.
    clock = NOW + 300_000;
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request) })).toEqual(refused("unknown_request"));
  });
  it("refuses results signed by an untrusted verifier key or for another audience", async () => {
    const { access_token } = await signIn();
    const { request } = await challenge(access_token);
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request, {}, rogue.privateKey) }))
      .toEqual(refused("invalid_signature"));
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request, {}, rogue.privateKey, "rogue-1") }))
      .toEqual(refused("verifier_key_unavailable"));
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request, { issuer: "https://rogue.example" }) }))
      .toEqual(refused("verifier_key_unavailable"));
    expect(await ask(access_token, { requestId: request.id, result: await resultFor(request, { audience: "https://gatekeeper.example" }) }))
      .toEqual(refused("result_audience_mismatch"));
    // None of the failures consumed the request.
    expect((await ask(access_token, { requestId: request.id, result: await resultFor(request) })).body.outcome).toBe("allow");
  });
});

describe("decision ledger", () => {
  const decision = (id: string, principalId = "p1"): LedgerDecision => ({
    schema: DEMO_PEP_LEDGER_PROFILE.decision, id, at: NOW, action: "a", resourceId: "r", outcome: "allow",
    reason: "x", principalId, policyRevision: "rev", evidence: [],
  });
  it("seals hash-chained epochs whose inclusion proofs verify; a tampered leaf or decision fails", async () => {
    for (let i = 1; i <= 5; i++) await appendDecision(store, decision(`d${i}`));
    const first = await sealEpoch(store, NOW);
    expect(first).toMatchObject({ epoch: 1, firstSeq: 1, lastSeq: 5, size: 5, firstPrevHash: "0".repeat(64) });
    for (let i = 6; i <= 7; i++) await appendDecision(store, decision(`d${i}`));
    const receipts: DecisionReceipt[] = [];
    for (let i = 1; i <= 7; i++) receipts.push(await decisionReceipt(store, `d${i}`, "p1", NOW));
    // Epoch 2 continues epoch 1.
    expect(receipts[6]!.epoch).toMatchObject({ epoch: 2, firstSeq: 6, lastSeq: 7, firstPrevHash: first!.lastLeafHash });
    for (const r of receipts) {
      expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, r)).toEqual({ ok: true });
      expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, r, r.epoch)).toEqual({ ok: true });
    }
    const r = receipts[2]!;
    expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, { ...r, leafHash: receipts[3]!.leafHash }))
      .toEqual({ ok: false, reason: "commitment_mismatch" });
    expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, { ...r, decision: { ...r.decision, outcome: "deny" } }))
      .toEqual({ ok: false, reason: "commitment_mismatch" });
    expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, { ...r, path: [...r.path].reverse() }))
      .toEqual({ ok: false, reason: "not_included" });
    expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, r, "f".repeat(64))).toEqual({ ok: false, reason: "root_mismatch" });
    expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, r, { ...r.epoch, size: r.epoch.size + 1 }))
      .toEqual({ ok: false, reason: "root_mismatch" });
    // Another profile's labels do not open the leaf.
    expect((await verifyDecisionReceipt({ ...DEMO_PEP_LEDGER_PROFILE, leaf: "gatekeeper.leaf/v1" }, r)).ok).toBe(false);
  });
  it("refuses to seal a tampered span and hides receipts from other principals", async () => {
    await appendDecision(store, decision("d1"));
    await appendDecision(store, decision("d2", "p2"));
    await expect(decisionReceipt(store, "d1", "p2", NOW)).rejects.toThrow("unknown_decision");
    const leaf = await store.get<any>("ledger:leaf:1");
    await store.put("ledger:leaf:1", { ...leaf, canonical: leaf.canonical.replace('"allow"', '"deny"') });
    await expect(sealEpoch(store, NOW)).rejects.toThrow("chain_broken");
  });
  it("serves the caller's decision receipt over HTTP after an allow", async () => {
    const { access_token } = await signIn();
    const { request } = await challenge(access_token);
    const allowed = await ask(access_token, { requestId: request.id, result: await resultFor(request) });
    const { status, body } = await send(`/api/demo-pep/decisions/${allowed.body.decisionId}/receipt`, { token: access_token });
    expect(status).toBe(200);
    expect(body.receipt.decision).toMatchObject({ id: allowed.body.decisionId, outcome: "allow", action: "vendor.payout.approve" });
    // The decision leaf holds no subject identifier in the clear, only its digest.
    expect(JSON.stringify(body.receipt.decision)).not.toContain(request.subject.subject);
    expect(await verifyDecisionReceipt(DEMO_PEP_LEDGER_PROFILE, body.receipt)).toEqual({ ok: true });
    expect(body.ledger.anchor.address).toBeNull();
    const other = await signIn();
    expect((await send(`/api/demo-pep/decisions/${allowed.body.decisionId}/receipt`, { token: other.access_token })).status).toBe(404);
    const epoch = await send(`/api/demo-pep/epochs/${body.receipt.epoch.epoch}`);
    expect(epoch.body.root).toBe(body.receipt.epoch.root);
  });
});
