import { describe, expect, it } from "vitest";
import { POD_INT_MAX } from "@pcd/pod";
import {
  holderPublicKey,
  insuranceProofConfig,
  issueInsurancePod,
  newHolderIdentity,
  serializePod
} from "../src/index";

const ISSUER_PRIVATE_KEY = "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8";

describe("POD/GPC adapter", () => {
  it("issues a signed, holder-bound insurance POD", () => {
    const identity = newHolderIdentity();
    const pod = issueInsurancePod({
      attestationId: "att:insurance",
      subjectBinding: "subject:acme",
      ownerPublicKey: holderPublicKey(identity),
      aggregateUsd: 5_000_000n,
      perOccurrenceUsd: 2_000_000n,
      validUntilEpochSeconds: 1_830_297_600n,
      additionalInsured: true,
      waiverOfSubrogation: true
    }, ISSUER_PRIVATE_KEY);

    expect(pod.verifySignature()).toBe(true);
    expect(serializePod(pod).entries.aggregate_usd).toBeDefined();
  });

  it("builds a hidden range-proof policy", () => {
    const config = insuranceProofConfig({
      aggregateMinimumUsd: 2_000_000n,
      perOccurrenceMinimumUsd: 1_000_000n,
      validThroughEpochSeconds: 1_800_000_000n,
      requireAdditionalInsured: true,
      requireWaiverOfSubrogation: true,
      challenge: "project-817",
      acceptedIssuerPublicKeys: ["issuer-key"]
    });
    const insurance = config.pods.insurance!;
    expect(insurance.entries.aggregate_usd?.isRevealed).toBe(false);
    expect(insurance.entries.aggregate_usd?.inRange).toEqual({ min: 2_000_000n, max: POD_INT_MAX });
    expect(insurance.signerPublicKey?.isRevealed).toBe(false);
  });
});
