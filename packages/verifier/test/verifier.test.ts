import path from "node:path";
import {deriveSignerPublicKey} from "@pcd/pod";
import {Effect} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {decodePublicKey, deriveSignerPublicKey as derive, encodePublicKey, POD} from "@pcd/pod";
import {issueCriteriaPod, proveCriteria} from "@attest/proofs";
import {
  canonicalPresentationBody, canonicalPublicKey, checkVerificationResult, isCanonicalPublicKey, criteriaRequestFor, PRESENTATION_SCHEMA, PROOF_REQUEST_SCHEMA, present, requestDigest, requirementDigest, signProofRequest,
  signVerificationResult, verifyPresentation, verifyProofRequest,
  type CredentialStatus, type Presentation, type PresentationVerifierPorts, type ProofRequest,
  type RequirementDefinition, type ResultVerification, type SubjectRef, type VerificationResult,
} from "../src/index.ts";

const artifacts = path.resolve(import.meta.dirname, "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts");
const NOW = 1_795_300_000_000;
const PEP = "https://gatekeeper.example/tenants/acme";
const VERIFIER = "https://verify.attest.example";
const IDP = "https://login.acme.example/api/auth";
const subject: SubjectRef = {issuer: IDP, subject: "user_8f2c"};
const carrierKey = "22".repeat(32), otherCarrierKey = "33".repeat(32);
const holderKey = "11".repeat(32), strangerKey = "44".repeat(32);
const holderPublicKey = deriveSignerPublicKey(holderKey);

const definition: RequirementDefinition = {
  id: "insurance.cgl.min-2m",
  schema: "attest:insurance:cgl:v1",
  criteria: [
    {field: "aggregate", kind: "number", operator: "gte", value: 2_000_000},
    {field: "per_occurrence", kind: "number", operator: "gte", value: 1_000_000},
  ],
  acceptedIssuers: [{id: "carrier:northwind", publicKey: deriveSignerPublicKey(carrierKey)}],
};
const fields = {aggregate: 5_000_000, per_occurrence: 2_000_000};

async function p256() {
  const pair = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  return {privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey), publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey)};
}
const credential = (values: Record<string, number>, key = carrierKey, holder = holderPublicKey) =>
  issueCriteriaPod({schema: definition.schema, subject: "supplier:acme", holderPublicKey: holder,
    issuerPublicKey: deriveSignerPublicKey(key), challenge: "unused", criteria: definition.criteria}, values, key);

let pep: Awaited<ReturnType<typeof p256>>, verifier: Awaited<ReturnType<typeof p256>>, rogue: Awaited<ReturnType<typeof p256>>;
let baseRequest: ProofRequest;
beforeAll(async () => {
  [pep, verifier, rogue] = await Promise.all([p256(), p256(), p256()]);
  baseRequest = {
    schema: PROOF_REQUEST_SCHEMA, id: "req-1", issuer: PEP, audience: VERIFIER, subject,
    credentialSubject: "supplier:acme", requirement: {id: definition.id, digest: await requirementDigest(definition)},
    decisionId: "dec-7", nonce: "n0nce-0123456789abcdefghij", issuedAt: NOW - 1000, expiresAt: NOW + 300_000,
  };
});

type World = {
  now: number; authorized: boolean; bound: boolean; status: CredentialStatus | null;
  consumed: Set<string>; requirement: RequirementDefinition | null;
};
function ports(w: World): PresentationVerifierPorts {
  return {
    verifierId: VERIFIER,
    resolveRequestKey: async (issuer, kid) => issuer === PEP && kid === "pep-1" ? pep.publicKey : null,
    requirement: async id => id === definition.id ? w.requirement : null,
    authorizedIssuer: async (issuer, requirement) => w.authorized && issuer === "carrier:northwind" && requirement === definition.id,
    holderBound: async (s, key) => w.bound && s.issuer === subject.issuer && s.subject === subject.subject && key === holderPublicKey,
    status: async () => w.status,
    consumeRequest: async id => w.consumed.has(id) ? false : (w.consumed.add(id), true),
    resultKey: {kid: "verifier-1", privateKey: verifier.privateKey},
    now: () => w.now, maxStatusAgeMs: 30_000, resultTtlMs: 120_000, newId: () => "res-1",
    proofArtifacts: artifacts,
  };
}
const activeStatus = (now = NOW): CredentialStatus => ({
  status: "active", validUntil: now + 3_600_000,
  evidence: {source: "chain", observedAt: now - 2000, chainId: 11155111, blockNumber: 7_000_000, blockHash: "0x" + "ab".repeat(32)},
});
const world = (over: Partial<World> = {}): World => ({
  now: NOW, authorized: true, bound: true, status: activeStatus(), consumed: new Set(), requirement: definition, ...over,
});
const sign = (r: ProofRequest, key = pep.privateKey) => signProofRequest(r, "pep-1", key);
const prove = (r: ProofRequest, pod = credential(fields), privateKey = holderKey) =>
  Effect.runPromise(present({request: r, definition, credential: pod, credentialIssuer: "carrier:northwind",
    credentialSubject: "supplier:acme", holderPrivateKey: privateKey, artifacts}));
const run = (token: string, p: unknown, w: World) => Effect.runPromise(verifyPresentation(token, p, ports(w)));
const code = async (promise: Promise<unknown>) => {
  try {await promise; return "ok";} catch (e) {return (e as {code?: string}).code ?? String(e);}
};
const expectedFor = async (r: ProofRequest): Promise<ResultVerification["expected"]> => ({
  requestDigest: await requestDigest(r), subject: r.subject, credentialSubject: r.credentialSubject,
  requirement: r.requirement, ...(r.decisionId ? {decisionId: r.decisionId} : {}),
});
const consumer = (expected: ResultVerification["expected"], over: Partial<ResultVerification> = {}): ResultVerification => ({
  resolveKey: async (issuer, kid) => issuer === VERIFIER && kid === "verifier-1" ? verifier.publicKey : null,
  trustedVerifier: async (issuer, requirement) => issuer === VERIFIER && requirement === definition.id,
  audience: PEP, now: NOW + 1000, expected, ...over,
});
/** An attacker bypassing the wallet's guards: a real proof for an arbitrary credential subject. */
async function forge(r: ProofRequest, credentialSubject: string): Promise<Presentation> {
  const pod = issueCriteriaPod({schema: definition.schema, subject: credentialSubject, holderPublicKey,
    issuerPublicKey: derive(carrierKey), challenge: "unused", criteria: definition.criteria}, fields, carrierKey);
  const digest = await requestDigest(r);
  const credential = {issuer: "carrier:northwind", subject: credentialSubject, contentId: pod.contentID.toString()};
  const proof = await proveCriteria(pod, criteriaRequestFor(definition, derive(carrierKey), digest, credential, holderPublicKey), artifacts);
  const unsigned = {schema: PRESENTATION_SCHEMA, requestDigest: digest, credential, holderPublicKey, proof} as const;
  return {...unsigned, holderSignature: POD.sign({presentation: {type: "string", value: canonicalPresentationBody(unsigned)}}, holderKey).toJSON()};
}

describe("proof requests", () => {
  it("round-trips a signed request and binds the digest to its exact contents", async () => {
    const token = await sign(baseRequest);
    const {request, digest} = await verifyProofRequest(token, {resolveKey: async () => pep.publicKey, audience: VERIFIER, now: NOW});
    expect(request).toEqual(baseRequest);
    expect(digest).toBe(await requestDigest(baseRequest));
    expect(await requestDigest({...baseRequest, nonce: "n0nce-0123456789abcdefghiX"})).not.toBe(digest);
  });
  it.each([
    ["forged signature", async () => sign(baseRequest, rogue.privateKey), {}, "invalid_signature"],
    ["wrong audience", async () => sign({...baseRequest, audience: "https://other.example"}), {}, "request_audience_mismatch"],
    ["expired", async () => sign(baseRequest), {now: NOW + 300_000}, "request_expired"],
    ["not yet valid", async () => sign(baseRequest), {now: NOW - 5000}, "request_not_yet_valid"],
  ] as const)("rejects a %s request", async (_name, make, over, expected) => {
    const options = {resolveKey: async () => pep.publicKey, audience: VERIFIER, now: NOW, ...over};
    expect(await code(verifyProofRequest(await make(), options))).toBe(expected);
  });
  it("refuses over-long lifetimes, weak nonces and tampered payloads", async () => {
    await expect(sign({...baseRequest, expiresAt: baseRequest.issuedAt + 600_001})).rejects.toThrow("invalid_request_time");
    await expect(sign({...baseRequest, nonce: "short"})).rejects.toThrow("invalid_request_nonce");
    const [h, , s] = (await sign(baseRequest)).split(".");
    const forgedBody = Buffer.from(JSON.stringify({...baseRequest, subject: {issuer: IDP, subject: "user_attacker"}}))
      .toString("base64url");
    expect(await code(verifyProofRequest(`${h}.${forgedBody}.${s}`,
      {resolveKey: async () => pep.publicKey, audience: VERIFIER, now: NOW}))).not.toBe("ok");
  });
});

describe("presentation verification", () => {
  let token: string, presentation: Presentation;
  beforeAll(async () => {
    token = await sign(baseRequest);
    presentation = await prove(baseRequest);
  });

  it("issues a short-lived signed result that reveals no hidden value, holder key or content ID", async () => {
    const {result, token: resultToken} = await run(token, presentation, world());
    expect(result).toMatchObject({
      issuer: VERIFIER, audience: PEP, requestId: "req-1", decisionId: "dec-7", subject, credentialSubject: "supplier:acme",
      requirement: baseRequest.requirement, credentialIssuer: "carrier:northwind", issuedAt: NOW,
    });
    // Capped by the status lease (observedAt + maxStatusAge), not just the TTL.
    expect(result.expiresAt).toBe(NOW - 2000 + 30_000);
    const serialized = JSON.stringify(result);
    for (const secret of ["5000000", "2000000000", holderPublicKey, presentation.credential.contentId])
      expect(serialized).not.toContain(secret);
    expect(await Effect.runPromise(checkVerificationResult(resultToken, consumer(await expectedFor(baseRequest))))).toEqual(result);
  });

  it("never outlives the request it answers", async () => {
    const short = {...baseRequest, id: "req-short", expiresAt: NOW + 10_000};
    const {result} = await run(await sign(short), await prove(short), world());
    expect(result.expiresAt).toBe(NOW + 10_000);
  });

  it("rejects mismatched subjects: a credential about a different entity than the request", async () => {
    const globex = {...baseRequest, id: "req-globex", credentialSubject: "supplier:globex"};
    // The wallet refuses outright; an attacker who bypasses it is refused by the verifier.
    await expect(prove(globex)).rejects.toThrow("credential_subject_mismatch");
    expect(await code(run(await sign(globex), await forge(globex, "supplier:acme"), world()))).toBe("credential_subject_mismatch");
  });

  it.each([
    ["addressed to another verifier", {audience: "https://other.example"}, "request_audience_mismatch"],
    ["expired", {expiresAt: NOW}, "request_expired"],
  ] as const)("rejects a request %s before any proof work", async (_name, over, expected) => {
    expect(await code(run(await sign({...baseRequest, ...over}), presentation, world()))).toBe(expected);
  });

  it("rejects requests from untrusted or impersonated enforcement points", async () => {
    expect(await code(run(await sign(baseRequest, rogue.privateKey), presentation, world()))).toBe("invalid_signature");
    const unknown = {...ports(world()), resolveRequestKey: async () => null};
    expect(await code(Effect.runPromise(verifyPresentation(token, presentation, unknown)))).toBe("request_issuer_key_unavailable");
  });

  it("cannot prove an insufficient hidden value", async () => {
    await expect(prove(baseRequest, credential({aggregate: 1_500_000, per_occurrence: 2_000_000}))).rejects.toThrow();
  });

  it("rejects a definition weaker than the one the request pinned", async () => {
    const weaker = {...definition, criteria: definition.criteria.slice(1)};
    expect(await code(run(token, presentation, world({requirement: weaker})))).toBe("requirement_mismatch");
    expect(await code(run(token, presentation, world({requirement: null})))).toBe("unknown_requirement");
  });

  it("rejects a presentation made for a different request", async () => {
    const other = await sign({...baseRequest, id: "req-2", nonce: "n0nce-zyxwvutsrqponmlkjihg"});
    expect(await code(run(other, presentation, world()))).toBe("presentation_request_mismatch");
  });

  it("rejects issuers that are not accepted or not currently authorized", async () => {
    expect(await code(run(token, presentation, world({authorized: false})))).toBe("unauthorized_credential_issuer");
    const relabelled = {...presentation, credential: {...presentation.credential, issuer: "carrier:unknown"}};
    // The holder signature covers the issuer label, so relabelling is caught even before the issuer check.
    expect(await code(run(token, relabelled, world()))).not.toBe("ok");
    const anyIssuer = {...ports(world()), authorizedIssuer: async () => true};
    const resigned = await forge(baseRequest, "supplier:acme");
    const outside = {...resigned, credential: {...resigned.credential, issuer: "carrier:unknown"}};
    expect(await code(Effect.runPromise(verifyPresentation(token, outside, anyIssuer)))).toBe("unaccepted_credential_issuer");
  });

  it("rejects a credential signed by an issuer outside the definition", async () => {
    await expect(prove(baseRequest, credential(fields, otherCarrierKey))).rejects.toThrow("unaccepted_credential_issuer");
  });

  it("rejects mismatched subjects: holder key not enrolled to the authenticated user", async () => {
    expect(await code(run(token, presentation, world({bound: false})))).toBe("holder_not_bound");
    const otherUser = await sign({...baseRequest, id: "req-3", subject: {issuer: IDP, subject: "user_mallory"}});
    expect(await code(run(otherUser, presentation, world()))).toBe("presentation_request_mismatch");
  });

  it("requires holder proof of possession over the whole presentation", async () => {
    const swapped = {...presentation, credential: {...presentation.credential, contentId: "1" + presentation.credential.contentId}};
    expect(await code(run(token, swapped, world()))).toBe("holder_signature_invalid");
    // A valid credential held by someone else cannot be presented by that holder for this user.
    const stranger = await prove(baseRequest, credential(fields, carrierKey, deriveSignerPublicKey(strangerKey)), strangerKey);
    expect(await code(run(token, stranger, world()))).toBe("holder_not_bound");
    // Nor can another holder's key sign over this user's enrolled key.
    await expect(prove(baseRequest, credential(fields), strangerKey)).rejects.toThrow();
  });

  it("rejects a tampered proof", async () => {
    const tampered = {...presentation, proof: {...presentation.proof, proofCommitment: "0".repeat(64)}};
    // The holder signature covers the proof, so re-signing is required to reach the proof check.
    expect(await code(run(token, tampered, world()))).toBe("holder_signature_invalid");
    const reject = {...ports(world()), verifyProof: async () => false};
    expect(await code(Effect.runPromise(verifyPresentation(token, presentation, reject)))).toBe("proof_invalid");
  });

  it("rejects stale, revoked, expired or missing status", async () => {
    const stale = activeStatus(); stale.evidence = {...stale.evidence, observedAt: NOW - 30_000};
    expect(await code(run(token, presentation, world({status: stale})))).toBe("status_stale");
    expect(await code(run(token, presentation, world({status: {...activeStatus(), status: "revoked"}})))).toBe("credential_not_active");
    expect(await code(run(token, presentation, world({status: {...activeStatus(), validUntil: NOW}})))).toBe("credential_not_active");
    expect(await code(run(token, presentation, world({status: null})))).toBe("status_unavailable");
    const future = activeStatus(); future.evidence = {...future.evidence, observedAt: NOW + 1};
    expect(await code(run(token, presentation, world({status: future})))).toBe("status_stale");
  });

  it("consumes each request once, and only after every other check passed", async () => {
    const w = world({bound: false});
    expect(await code(run(token, presentation, w))).toBe("holder_not_bound");
    expect(w.consumed.size).toBe(0);
    w.bound = true;
    expect(await code(run(token, presentation, w))).toBe("ok");
    expect(await code(run(token, presentation, w))).toBe("request_replayed");
  });
});

describe("result consumption", () => {
  let result: VerificationResult, token: string;
  beforeAll(async () => {
    result = {
      schema: "attest.verification-result/v1", id: "res-9", issuer: VERIFIER, audience: PEP, requestId: "req-1",
      requestDigest: "a".repeat(64), subject, credentialSubject: "supplier:acme",
      requirement: {id: definition.id, digest: "b".repeat(64)}, decisionId: "dec-7",
      credentialIssuer: "carrier:northwind", status: {source: "registry", observedAt: NOW - 1000},
      issuedAt: NOW, expiresAt: NOW + 60_000,
    };
    token = await signVerificationResult(result, "verifier-1", verifier.privateKey);
  });
  const expected = (): ResultVerification["expected"] => ({requestDigest: "a".repeat(64), subject,
    credentialSubject: "supplier:acme", requirement: {id: definition.id, digest: "b".repeat(64)}, decisionId: "dec-7"});
  it("accepts a result only for the exact pending request", async () => {
    expect((await Effect.runPromise(checkVerificationResult(token, consumer(expected())))).id).toBe("res-9");
  });
  const cases: [string, () => Partial<ResultVerification>, string][] = [
    ["a result for another request", () => ({expected: {...expected(), requestDigest: "c".repeat(64)}}), "result_binding_mismatch"],
    ["a result relayed by another user", () => ({expected: {...expected(), subject: {issuer: IDP, subject: "user_bob"}}}), "result_binding_mismatch"],
    ["a result about another entity", () => ({expected: {...expected(), credentialSubject: "supplier:globex"}}), "result_binding_mismatch"],
    ["a result for another decision", () => ({expected: {...expected(), decisionId: "dec-8"}}), "result_binding_mismatch"],
    ["a result for a different requirement version", () => ({expected: {...expected(), requirement: {id: definition.id, digest: "d".repeat(64)}}}), "result_binding_mismatch"],
    ["another enforcement point", () => ({audience: "https://gatekeeper.example/tenants/other"}), "result_audience_mismatch"],
    ["an expired result", () => ({now: NOW + 60_000}), "result_expired"],
    ["an untrusted verifier", () => ({trustedVerifier: async () => false}), "untrusted_verifier"],
    ["an unknown key", () => ({resolveKey: async () => null}), "verifier_key_unavailable"],
    ["a key from another verifier", () => ({resolveKey: async (): Promise<JsonWebKey> => rogue.publicKey}), "invalid_signature"],
  ];
  it.each(cases)("rejects %s", async (_name, over, expected_) => {
    expect(await code(Effect.runPromise(checkVerificationResult(token, consumer(expected(), over()))))).toBe(expected_);
  });
  it("refuses to sign results longer than five minutes or with incomplete chain evidence", async () => {
    await expect(signVerificationResult({...result, expiresAt: NOW + 300_001}, "verifier-1", verifier.privateKey))
      .rejects.toThrow("invalid_result_time");
    await expect(signVerificationResult({...result, status: {source: "chain", observedAt: NOW - 1}}, "verifier-1",
      verifier.privateKey)).rejects.toThrow("invalid_status_evidence");
  });
});

let provenOnce: Promise<Presentation> | undefined;
describe("holder key encodings (one key, one spelling)", () => {
  const aliases = () => {
    const hex = encodePublicKey(decodePublicKey(holderPublicKey), "hex");
    return {
      hex, upperHex: hex.toUpperCase(), mixedHex: hex.slice(0, 32).toUpperCase() + hex.slice(32),
      padded: holderPublicKey + "=",
    };
  };
  it("treats only unpadded base64 as canonical, though @pcd/pod decodes every alias to the same key", () => {
    expect(isCanonicalPublicKey(holderPublicKey)).toBe(true);
    for (const alias of Object.values(aliases())) {
      expect(canonicalPublicKey(alias)).toBe(holderPublicKey);
      expect(isCanonicalPublicKey(alias)).toBe(false);
    }
  });
  it.each(["hex", "upperHex", "mixedHex", "padded"] as const)("rejects a presentation whose holder key is %s-encoded", async (form) => {
    const token = await sign(baseRequest);
    const p = await (provenOnce ??= prove(baseRequest));
    const aliased = {...p, holderPublicKey: aliases()[form]};
    expect(await code(run(token, aliased, world()))).toBe("noncanonical_holder_key");
  });
});

describe("issuer-level status evidence", () => {
  it("signs and parses the issuer-authority source, and lets a PEP refuse it", async () => {
    const result: VerificationResult = {
      schema: "attest.verification-result/v1", id: "res-ia", issuer: VERIFIER, audience: PEP, requestId: "req-1",
      requestDigest: "a".repeat(64), subject, credentialSubject: "supplier:acme",
      requirement: {id: definition.id, digest: "b".repeat(64)}, credentialIssuer: "carrier:northwind",
      status: {source: "issuer-authority", observedAt: NOW - 1000}, issuedAt: NOW, expiresAt: NOW + 60_000,
    };
    const token = await signVerificationResult(result, "verifier-1", verifier.privateKey);
    const expected = {requestDigest: "a".repeat(64), subject, credentialSubject: "supplier:acme",
      requirement: {id: definition.id, digest: "b".repeat(64)}};
    expect((await Effect.runPromise(checkVerificationResult(token, consumer(expected)))).status.source).toBe("issuer-authority");
    expect(await code(Effect.runPromise(checkVerificationResult(token, consumer(expected, {acceptedStatusSources: ["chain"]})))))
      .toBe("status_source_not_accepted");
    await expect(signVerificationResult({...result, status: {source: "pinned" as never, observedAt: NOW - 1}}, "verifier-1",
      verifier.privateKey)).rejects.toThrow("invalid_status_evidence");
    await expect(signVerificationResult({...result, status: {source: "issuer-authority", observedAt: NOW - 1, chainId: 1,
      blockNumber: 1, blockHash: "0x" + "ab".repeat(32)}}, "verifier-1", verifier.privateKey)).rejects.toThrow("invalid_status_evidence");
  });
});
