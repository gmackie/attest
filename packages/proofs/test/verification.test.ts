import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { commitValue } from "@attest/core";
import {
  holderPublicKey, insuranceProofConfig, issueInsurancePod, newHolderIdentity,
  proveInsuranceRequirement, verifyInsuranceRequirement,
  type GpcProofEnvelope, type InsuranceRequirement
} from "../src/index";

// Exercise real Groth16 verification using installed artifacts, without network access.
const artifacts = path.resolve(import.meta.dirname, "../node_modules/@pcd/proto-pod-gpc-artifacts");
const identity = newHolderIdentity();
const pod = issueInsurancePod({
  attestationId: "att:regression", subjectBinding: "subject:acme",
  ownerPublicKey: holderPublicKey(identity), aggregateUsd: 5_000_000n,
  perOccurrenceUsd: 2_000_000n, validUntilEpochSeconds: 1_830_297_600n,
  additionalInsured: true, waiverOfSubrogation: true
}, "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8");
const requirement: InsuranceRequirement = {
  subjectBinding: "subject:acme",
  aggregateMinimumUsd: 2_000_000n, perOccurrenceMinimumUsd: 1_000_000n,
  validThroughEpochSeconds: 1_800_000_000n,
  requireAdditionalInsured: true, requireWaiverOfSubrogation: true,
  challenge: "buyer-request-a", acceptedIssuerPublicKeys: [pod.signerPublicKey]
};
let envelope: GpcProofEnvelope;
beforeAll(async () => {
  envelope = await proveInsuranceRequirement(pod, identity, requirement, artifacts);
}, 120_000);

describe("verifier request binding", () => {
  it("accepts the original request", async () => {
    expect(await verifyInsuranceRequirement(envelope, requirement, artifacts)).toBe(true);
  });

  it("rejects a proof replayed for another challenge", async () => {
    expect(await verifyInsuranceRequirement(envelope, { ...requirement, challenge: "buyer-request-b" }, artifacts)).toBe(false);
  });

  it("rejects an issuer the verifier has not accepted", async () => {
    expect(await verifyInsuranceRequirement(envelope, {
      ...requirement, acceptedIssuerPublicKeys: [holderPublicKey(newHolderIdentity())]
    }, artifacts)).toBe(false);
  });

  it("rejects a proof for another subject", async () => {
    expect(await verifyInsuranceRequirement(envelope, { ...requirement, subjectBinding: "subject:other" }, artifacts)).toBe(false);
  });

  it("rejects an empty accepted issuer set", async () => {
    expect(await verifyInsuranceRequirement(envelope, { ...requirement, acceptedIssuerPublicKeys: [] }, artifacts)).toBe(false);
  });

  it.each(["challenge", "issuer", "subject"])("rejects a forged request commitment with changed %s", async (field) => {
    const differentRequest = {
      ...requirement,
      ...(field === "challenge" ? { challenge: "buyer-request-b" } : {}),
      ...(field === "issuer" ? { acceptedIssuerPublicKeys: [holderPublicKey(newHolderIdentity())] } : {}),
      ...(field === "subject" ? { subjectBinding: "subject:other" } : {})
    };
    const { proofConfigToJSON } = await import("@pcd/gpc");
    const policyCommitment = await commitValue({ config: proofConfigToJSON(insuranceProofConfig(differentRequest)), requirement: differentRequest });
    expect(await verifyInsuranceRequirement({ ...envelope, policyCommitment }, differentRequest, artifacts)).toBe(false);
  });

  it("rejects altered public inputs even when their transcript commitment is recomputed", async () => {
    const altered = { ...envelope, revealedClaims: { ...envelope.revealedClaims, watermark: "tampered" } };
    const proofCommitment = await commitValue({ proof: altered.proof, boundConfig: altered.boundConfig, revealedClaims: altered.revealedClaims });
    expect(await verifyInsuranceRequirement({ ...altered, proofCommitment }, requirement, artifacts)).toBe(false);
  });
});


it("cannot prove another subject's credential for the requested subject", async () => {
  await expect(proveInsuranceRequirement(pod, identity, { ...requirement, subjectBinding: "subject:other" }, artifacts)).rejects.toThrow();
});

it("supports requests without endorsements", async () => {
  const relaxed = { ...requirement, requireAdditionalInsured: false, requireWaiverOfSubrogation: false };
  const proof = await proveInsuranceRequirement(pod, identity, relaxed, artifacts);
  expect(await verifyInsuranceRequirement(proof, relaxed, artifacts)).toBe(true);
}, 120_000);
