/**
 * End to end, in process: the web journey's client flow (packages/demo/src/vendor-portal.ts)
 * against the demo PEP and the real attest-verifier handler, with a real GPC presentation.
 * Sign in → challenge → enroll → present → signed result → allow → receipt verifies.
 */
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createHandler } from "../../verifier/src/handler";
import { EnrollmentStore, type DurableState } from "../../verifier/src/enrollment";
import { ReplayStore } from "../../verifier/src/replay";
import type { DurableObjectNamespaceLike, Env as VerifierEnv } from "../../verifier/src/config";
import { createDemoPep } from "../src/demo-pep/pep";
import type { DemoPepEnv } from "../src/demo-pep/config";
import {
  authorize, checkChallenge, demoSignIn, enroll, fetchReceipt, fetchRequirement, issueDemoCredential, newHolder, prove,
  submitPresentation, verifyReceipt, type Fetch, type PortalEndpoints,
} from "../../../packages/demo/src/vendor-portal";
import { MemoryStore } from "./memory-store";

const artifacts = path.resolve(import.meta.dirname, "../../verifier/node_modules/@pcd/proto-pod-gpc-artifacts");
const endpoints: PortalEndpoints = { pep: "https://attest.example/api/demo-pep", verifier: "https://verify.attest.example" };
const DIGEST = "2251414534a86a6cbe9b53d6a030b6fbe4437f8d1e7341ec0bc91246846b3d20";

class MemoryStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async deleteAll() { this.data.clear(); }
  async setAlarm() {}
}
class FakeNamespace implements DurableObjectNamespaceLike {
  instances = new Map<string, { fetch(r: Request): Promise<Response> }>();
  constructor(private make: (state: DurableState) => { fetch(r: Request): Promise<Response> }) {}
  idFromName(name: string) { return { toString: () => name }; }
  get(id: { toString(): string }) {
    const name = id.toString();
    if (!this.instances.has(name)) this.instances.set(name, this.make({ storage: new MemoryStorage() }));
    const object = this.instances.get(name)!;
    return { fetch: (input: string, init?: RequestInit) => object.fetch(new Request(input, init)) };
  }
}
async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { privateKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! },
    publicKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } };
}

let fetcher: Fetch;
let pepStore: MemoryStore;

beforeAll(async () => {
  const [pepKey, idKey, resultKey] = await Promise.all([keyPair(), keyPair(), keyPair()]);
  const pepEnv: DemoPepEnv = {
    DEMO_PEP_ISSUER: endpoints.pep,
    DEMO_PEP_VERIFIER: JSON.stringify({ issuer: endpoints.verifier, endpoint: `${endpoints.verifier}/v1/presentations`,
      keys: [{ kid: "verifier-1", publicKey: resultKey.publicKey }], requirements: [{ id: "demo.insurance.cgl.min-2m", digest: DIGEST }] }),
    DEMO_PEP_SIGNING_KEY: JSON.stringify({ active: "pep-1", keys: [{ kid: "pep-1", privateKey: pepKey.privateKey }] }),
    DEMO_IDENTITY_SIGNING_KEY: JSON.stringify({ active: "id-1", keys: [{ kid: "id-1", privateKey: idKey.privateKey }] }),
  };
  // Exactly the entries the deploy notes tell the verifier operator to add.
  const verifierEnv: VerifierEnv = {
    VERIFIER_ID: endpoints.verifier,
    TRUSTED_PEPS: JSON.stringify([{ issuer: endpoints.pep, keys: [{ kid: "pep-1", publicKey: pepKey.publicKey }] }]),
    IDENTITY_PROVIDERS: JSON.stringify([{ issuer: `${endpoints.pep}/identity`, jwksUri: `${endpoints.pep}/identity/jwks`,
      audience: endpoints.verifier, clientId: "attest-vendor-portal-demo", bindingTtlMs: 86_400_000 }]),
    RESULT_SIGNING_KEYS: JSON.stringify({ active: "verifier-1", keys: [{ kid: "verifier-1", privateKey: resultKey.privateKey }] }),
    SEPOLIA_RPC_URL: "https://rpc-a.example", SEPOLIA_RPC_URL_SECONDARY: "https://rpc-b.example",
    REPLAY: new FakeNamespace((s) => new ReplayStore(s)), ENROLLMENTS: new FakeNamespace((s) => new EnrollmentStore(s)),
  };
  pepStore = new MemoryStore();
  const pep = createDemoPep();
  const route = (input: string, init?: RequestInit) => {
    // Browsers send Content-Length for string bodies; Node's Request does not add it to headers.
    const headers = new Headers(init?.headers);
    if (typeof init?.body === "string") headers.set("content-length", String(Buffer.byteLength(init.body)));
    const request = new Request(input, { ...init, headers });
    if (input.startsWith(endpoints.pep)) return pep(request, pepEnv, pepStore);
    if (input.startsWith(endpoints.verifier)) return verifier(request, verifierEnv);
    throw new Error(`unexpected fetch ${input}`);
  };
  const verifier = createHandler({
    // The demo carrier is a pinned issuer: no chain read is needed, and none is allowed here.
    endpoints: () => { throw new Error("no chain in this test"); },
    // The verifier fetches the demo identity's JWKS from the PEP, as it would over HTTPS.
    fetchJwks: async (uri) => (await route(uri)).json() as Promise<{ keys: JsonWebKey[] }>,
    proofArtifacts: artifacts,
  });
  fetcher = route;
});

describe("vendor portal: prove to access (demo PEP + verifier + GPC)", () => {
  it("challenge → enroll → present → result → allow → receipt inclusion verifies", async () => {
    const session = await demoSignIn(endpoints, fetcher);
    expect(session.demo).toBe(true);

    const first = await authorize(endpoints, fetcher, session);
    expect(first).toMatchObject({ outcome: "challenge", reason: "attest_presentation_required" });
    const challenge = first.attest!.requests![0]!;
    const request = await checkChallenge(endpoints, fetcher, challenge, session);
    expect(request.decisionId).toBe(first.decisionId);

    const holder = newHolder();
    const enrolled = await enroll(endpoints, fetcher, session, holder);
    expect(enrolled).toMatchObject({ enrolled: true });
    // The demo identity's bindings expire (bindingTtlMs), so anonymous enrollments do not accumulate.
    expect((enrolled as { expiresAt?: number }).expiresAt).toBeGreaterThan(Date.now());
    const { definition, synthetic } = await fetchRequirement(endpoints, fetcher, request);
    expect(synthetic).toBe(true);
    const presentation = await prove(request, definition, issueDemoCredential(definition, holder), holder, artifacts);
    // The presentation carries the public thresholds (scaled ×1000) but not the hidden coverage values.
    expect(JSON.stringify(presentation)).toContain("2000000000");
    expect(JSON.stringify(presentation)).not.toMatch(/5000000000|2500000000|5000000\b|2500000\b/);
    const { result } = await submitPresentation(endpoints, fetcher, challenge, presentation);

    // A replay of the same presentation is refused by the verifier.
    await expect(submitPresentation(endpoints, fetcher, challenge, presentation)).rejects.toThrow("request_replayed");

    const allowed = await authorize(endpoints, fetcher, session, { requestId: challenge.requestId, result });
    expect(allowed).toMatchObject({ outcome: "allow", reason: "policy_satisfied" });
    // The same result cannot be used twice at the PEP.
    await expect(authorize(endpoints, fetcher, session, { requestId: challenge.requestId, result })).rejects.toThrow("request_consumed");

    const { receipt, ledger } = await fetchReceipt(endpoints, fetcher, session, allowed.decisionId);
    expect(ledger.anchor.status).toBe("not-configured");
    const check = await verifyReceipt(receipt, allowed.decisionId);
    expect(check).toEqual({ local: { ok: true }, inclusion: true, matchesDecision: true });
    // Against the sealed epoch as published by the PEP (not on-chain: no anchor is configured).
    const epoch = await (await fetcher(`${endpoints.pep}/epochs/${receipt.epoch.epoch}`)).json() as { root: string; epoch: number; firstSeq: number; lastSeq: number; size: number };
    expect((await verifyReceipt(receipt, allowed.decisionId, epoch)).local).toEqual({ ok: true });
    // Tampered leaf fails.
    expect((await verifyReceipt({ ...receipt, leafHash: "0".repeat(64) }, allowed.decisionId)).local.ok).toBe(false);
  });

  it("a different user cannot present against someone else's challenge", async () => {
    const alice = await demoSignIn(endpoints, fetcher), mallory = await demoSignIn(endpoints, fetcher);
    const challenge = (await authorize(endpoints, fetcher, alice)).attest!.requests![0]!;
    await expect(checkChallenge(endpoints, fetcher, challenge, mallory)).rejects.toThrow("request_subject_mismatch");
    // Mallory enrolls her own holder key; the verifier refuses it for Alice's request.
    const holder = newHolder();
    await enroll(endpoints, fetcher, mallory, holder);
    const request = await checkChallenge(endpoints, fetcher, challenge, alice);
    const { definition } = await fetchRequirement(endpoints, fetcher, request);
    const presentation = await prove(request, definition, issueDemoCredential(definition, holder), holder, artifacts);
    await expect(submitPresentation(endpoints, fetcher, challenge, presentation)).rejects.toThrow("holder_not_bound");
  });
});
