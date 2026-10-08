import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { integerValue, type Attestation, type AuthorityGraph } from "@attest/domain";
import { gte, type RequirementProfile } from "@attest/policy";
import { createPersona, createPresentationContext, PrivateEvidenceWallet } from "../src/index";

const attestation: Attestation = {
  id: "att:insurance",
  schema: "attest:insurance:v1",
  subject: "subject:acme",
  issuer: "issuer:carrier",
  claims: {
    "insurance.cgl.aggregate": integerValue(5_000_000, "USD"),
    "identity.legalName": { kind: "string", value: "ACME Electrical LLC" }
  },
  evidence: [],
  assurance: "authoritative-source",
  issuedAt: "2026-01-01T00:00:00.000Z",
  status: "active"
};

const authority: AuthorityGraph = {
  acceptedRoots: ["root:insurance"],
  grants: [{
    id: "grant",
    grantor: "root:insurance",
    grantee: "issuer:carrier",
    actions: ["issue"],
    predicatePatterns: ["insurance.*"],
    mayDelegate: false
  }]
};

const profile: RequirementProfile = {
  id: "project",
  name: "Project",
  description: "Project",
  subject: "subject:acme",
  acceptedRoots: authority.acceptedRoots,
  evaluatedAt: "2027-01-01T00:00:00.000Z",
  root: gte("aggregate", "CGL aggregate ≥ $2M", "insurance.cgl.aggregate", integerValue(2_000_000, "USD"))
};

describe("private evidence wallet", () => {
  it("lets a root-authorized presentation combine selected persona evidence", async () => {
    const wallet = new PrivateEvidenceWallet("root:holder")
      .addPersona(createPersona("persona:business", "Business", ["insurance.*"]))
      .ingest(attestation, "persona:business");

    const context = createPresentationContext(
      "presentation:buyer",
      "Buyer assurance",
      ["persona:business"],
      ["insurance.*"]
    );

    const result = await Effect.runPromise(wallet.plan(context, profile, authority));
    expect(result.satisfied).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ACME Electrical LLC");
  });

  it("does not leak excluded namespaces into a presentation", async () => {
    const wallet = new PrivateEvidenceWallet("root:holder")
      .addPersona(createPersona("persona:business", "Business", ["insurance.*"]))
      .ingest(attestation, "persona:business");
    const context = createPresentationContext("presentation:buyer", "Buyer", ["persona:business"], ["identity.*"]);
    const result = await Effect.runPromise(wallet.plan(context, profile, authority));
    expect(result.satisfied).toBe(false);
  });
});
