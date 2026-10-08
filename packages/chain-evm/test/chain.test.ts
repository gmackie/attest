import { describe, expect, it } from "vitest";
import { makeVerificationReceipt } from "../src/index";

describe("verification receipts", () => {
  it("are deterministic for the same anchored event", async () => {
    const input = {
      policyId: "policy:817",
      policyCommitment: "0xpolicy",
      evidenceRoot: "0xevidence",
      proofCommitment: "0xproof",
      subjectNullifier: "0xpairwise",
      satisfied: true,
      verifiedAt: "2026-10-07T21:00:00.000Z"
    } as const;
    expect(await makeVerificationReceipt(input)).toEqual(await makeVerificationReceipt(input));
  });
});
