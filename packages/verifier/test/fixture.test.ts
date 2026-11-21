import {readFileSync} from "node:fs";
import {expect, it} from "vitest";
import {requestDigest, requirementDigest, verifyProofRequest, verifyVerificationResult} from "../src/index.ts";

const v = JSON.parse(readFileSync(new URL("../fixtures/verifier-v1.json", import.meta.url), "utf8"));

it("publishes public keys only", () => {
  expect(v.pepPublicKey.d).toBeUndefined();
  expect(v.verifierPublicKey.d).toBeUndefined();
});

it("verifies the shared interop vector the way Gatekeeper will", async () => {
  expect(await requirementDigest(v.requirement)).toBe(v.request.requirement.digest);
  expect(await requestDigest(v.request)).toBe(v.requestDigest);
  const {request} = await verifyProofRequest(v.requestToken, {
    resolveKey: async (issuer, kid) => issuer === v.request.issuer && kid === v.pepKid ? v.pepPublicKey : null,
    audience: v.request.audience, now: v.now,
  });
  expect(request).toEqual(v.request);
  const result = await verifyVerificationResult(v.resultToken, {
    resolveKey: async (issuer, kid) => issuer === v.result.issuer && kid === v.verifierKid ? v.verifierPublicKey : null,
    trustedVerifier: async (issuer, requirement) => issuer === v.result.issuer && requirement === v.requirement.id,
    audience: v.request.issuer, now: v.now + 1000,
    expected: {requestDigest: v.requestDigest, subject: v.request.subject, credentialSubject: v.request.credentialSubject,
      requirement: v.request.requirement, decisionId: v.request.decisionId},
  });
  expect(result).toEqual(v.result);
  expect(result.credentialSubject).toBe(v.request.credentialSubject);
});
