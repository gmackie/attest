import { describe, expect, it } from "vitest";
import { booleanValue, dateValue, integerValue, stringValue, type Attestation, type AuthorityGraph } from "@attest/domain";
import { all, any, eq, evaluatePolicy, gte, type RequirementProfile } from "../src/index";

const authority: AuthorityGraph = {
  acceptedRoots: ["root:insurance", "root:audit"],
  grants: [
    {
      id: "insurance-grant",
      grantor: "root:insurance",
      grantee: "issuer:carrier",
      actions: ["issue"],
      predicatePatterns: ["insurance.*"],
      mayDelegate: false
    },
    {
      id: "audit-grant",
      grantor: "root:audit",
      grantee: "issuer:cpa",
      actions: ["issue"],
      predicatePatterns: ["soc2.*"],
      mayDelegate: false
    }
  ]
};

const insurance: Attestation = {
  id: "att:insurance",
  schema: "attest:insurance:v1",
  subject: "subject:acme",
  issuer: "issuer:carrier",
  claims: {
    "insurance.cgl.aggregate": integerValue(5_000_000, "USD"),
    "insurance.cgl.perOccurrence": integerValue(2_000_000, "USD"),
    "insurance.additionalInsured": booleanValue(true),
    "insurance.validUntil": dateValue("2028-01-01T00:00:00.000Z")
  },
  evidence: [],
  assurance: "authoritative-source",
  issuedAt: "2026-01-01T00:00:00.000Z",
  validUntil: "2028-01-01T00:00:00.000Z",
  status: "active"
};

const soc2: Attestation = {
  id: "att:soc2",
  schema: "attest:soc2:v1",
  subject: "subject:acme",
  issuer: "issuer:cpa",
  claims: {
    "soc2.report.type": stringValue("type-ii"),
    "soc2.materialExceptions": integerValue(0)
  },
  evidence: [],
  assurance: "authoritative-source",
  issuedAt: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-12-31T00:00:00.000Z",
  status: "active"
};

const profile = (root: RequirementProfile["root"]): RequirementProfile => ({
  id: "profile:test",
  name: "Test",
  description: "Test",
  subject: "subject:acme",
  acceptedRoots: authority.acceptedRoots,
  evaluatedAt: "2027-01-01T00:00:00.000Z",
  root
});

describe("policy planning", () => {
  it("matches hidden numeric thresholds without returning the hidden value", () => {
    const result = evaluatePolicy(profile(gte("aggregate", "CGL aggregate ≥ $2M", "insurance.cgl.aggregate", integerValue(2_000_000, "USD"))), [insurance], authority);
    expect(result.satisfied).toBe(true);
    expect(result.witnessIds).toEqual(["att:insurance"]);
    expect(JSON.stringify(result)).not.toContain("5000000");
  });

  it("fails when the hidden value is below the policy threshold", () => {
    const result = evaluatePolicy(profile(gte("aggregate", "CGL aggregate ≥ $10M", "insurance.cgl.aggregate", integerValue(10_000_000, "USD"))), [insurance], authority);
    expect(result.satisfied).toBe(false);
  });

  it("does not mix subjects", () => {
    const other = { ...soc2, subject: "subject:other" } satisfies Attestation;
    const root = all(
      "all",
      gte("aggregate", "CGL aggregate ≥ $2M", "insurance.cgl.aggregate", integerValue(2_000_000, "USD")),
      eq("type", "SOC 2 Type II", "soc2.report.type", stringValue("type-ii"))
    );
    expect(evaluatePolicy(profile(root), [insurance, other], authority).satisfied).toBe(false);
  });

  it("selects the lower-disclosure successful branch", () => {
    const one = gte("aggregate", "CGL aggregate ≥ $2M", "insurance.cgl.aggregate", integerValue(2_000_000, "USD"));
    const two = all(
      "two",
      eq("type", "SOC 2 Type II", "soc2.report.type", stringValue("type-ii")),
      eq("exceptions", "No material exceptions", "soc2.materialExceptions", integerValue(0))
    );
    const result = evaluatePolicy(profile(any("alternatives", two, one)), [insurance, soc2], authority);
    expect(result.satisfied).toBe(true);
    expect(result.witnessIds).toEqual(["att:insurance"]);
  });
});
