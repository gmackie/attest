/**
 * Regenerates fixtures/verifier-v1.json: a signed proof request and a signed
 * verification result for cross-repository interop tests (Gatekeeper vendors
 * it, as it does packages/mandates/fixtures/mandate-v1.json). Public keys only.
 * Usage: pnpm --filter @attest/verifier fixture
 */
import {writeFileSync} from "node:fs";
// Import the codec modules directly: they do not load the POD/GPC proof stack.
import {PROOF_REQUEST_SCHEMA, requestDigest, signProofRequest, type ProofRequest} from "../src/request.ts";
import {requirementDigest, type RequirementDefinition} from "../src/requirement.ts";
import {signVerificationResult, VERIFICATION_RESULT_SCHEMA, type VerificationResult} from "../src/result.ts";

const now = 1_795_300_000_000;
const pair = async () => {
  const keys = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  return {privateKey: await crypto.subtle.exportKey("jwk", keys.privateKey), publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey)};
};
const pep = await pair(), verifier = await pair();
const requirement: RequirementDefinition = {
  id: "insurance.cgl.min-2m", schema: "attest:insurance:cgl:v1",
  criteria: [
    {field: "aggregate", kind: "number", operator: "gte", value: 2_000_000},
    {field: "per_occurrence", kind: "number", operator: "gte", value: 1_000_000},
  ],
  acceptedIssuers: [{id: "carrier:northwind", publicKey: "synthetic-eddsa-public-key-placeholder"}],
};
const request: ProofRequest = {
  schema: PROOF_REQUEST_SCHEMA, id: "req-fixture-1", issuer: "https://gatekeeper.example/tenants/acme",
  audience: "https://verify.attest.example",
  subject: {issuer: "https://login.acme.example/api/auth", subject: "user_8f2c"}, credentialSubject: "supplier:acme",
  requirement: {id: requirement.id, digest: await requirementDigest(requirement)},
  decisionId: "dec-fixture-1", nonce: "fixture-nonce-0123456789ab", issuedAt: now - 1000, expiresAt: now + 300_000,
};
const digest = await requestDigest(request);
const result: VerificationResult = {
  schema: VERIFICATION_RESULT_SCHEMA, id: "res-fixture-1", issuer: request.audience, audience: request.issuer,
  requestId: request.id, requestDigest: digest, decisionId: "dec-fixture-1", subject: request.subject,
  credentialSubject: request.credentialSubject, requirement: request.requirement, credentialIssuer: "carrier:northwind",
  status: {source: "chain", observedAt: now - 2000, chainId: 11155111, blockNumber: 7_000_000, blockHash: "0x" + "ab".repeat(32)},
  issuedAt: now, expiresAt: now + 28_000,
};
const fixture = {
  description: "Synthetic attest.proof-request/v1 and attest.verification-result/v1 interop vector. Not real credentials.",
  now, requirement, request, requestDigest: digest,
  requestToken: await signProofRequest(request, "pep-1", pep.privateKey), pepKid: "pep-1", pepPublicKey: pep.publicKey,
  result, resultToken: await signVerificationResult(result, "verifier-1", verifier.privateKey),
  verifierKid: "verifier-1", verifierPublicKey: verifier.publicKey,
};
writeFileSync(new URL("../fixtures/verifier-v1.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote fixtures/verifier-v1.json");
