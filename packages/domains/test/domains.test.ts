import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@attest/policy";
import { createSupplierPolicy, defaultThresholds, demoAttestations, demoAuthorityGraph } from "../src/index";

describe("B2B assurance domain pack", () => {
  it("satisfies the default project policy", () => {
    const result = evaluatePolicy(createSupplierPolicy(), demoAttestations, demoAuthorityGraph);
    expect(result.satisfied).toBe(true);
    expect(result.leaves).toHaveLength(12);
    expect(new Set(result.witnessIds)).toEqual(new Set([
      "att:insurance:acme:2027",
      "att:soc2:acme:2026",
      "att:iso9001:acme:2026"
    ]));
  });

  it("fails a $10M aggregate requirement without revealing the $5M source value", () => {
    const result = evaluatePolicy(createSupplierPolicy({
      ...defaultThresholds,
      aggregateMinimumUsd: 10_000_000n
    }), demoAttestations, demoAuthorityGraph);
    expect(result.satisfied).toBe(false);
    expect(JSON.stringify(result)).not.toContain("5000000");
  });
});
