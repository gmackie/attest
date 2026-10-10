import { describe, expect, it } from "vitest";
import type { AuthorityGraph } from "@attest/domain";
import { resolveAuthority } from "../src/index";

const graph: AuthorityGraph = {
  acceptedRoots: ["root:insurance"],
  grants: [
    {
      id: "root-to-clearinghouse",
      grantor: "root:insurance",
      grantee: "issuer:clearinghouse",
      actions: ["issue"],
      predicatePatterns: ["insurance.*"],
      validUntil: "2030-01-01T00:00:00.000Z",
      mayDelegate: true,
      maxDelegationDepth: 1
    },
    {
      id: "clearinghouse-to-agent",
      grantor: "issuer:clearinghouse",
      grantee: "issuer:agent",
      actions: ["issue"],
      predicatePatterns: ["insurance.cgl.*"],
      validUntil: "2028-01-01T00:00:00.000Z",
      mayDelegate: false
    }
  ]
};

const query = {
  issuer: "issuer:agent",
  action: "issue" as const,
  predicate: "insurance.cgl.aggregate",
  schema: "attest:insurance:v1",
  at: "2027-01-01T00:00:00.000Z"
};

describe("scoped authority", () => {
  it("resolves an attenuated delegation chain", () => {
    const result = resolveAuthority(graph, query);
    expect(result.authorized).toBe(true);
    expect(result.root).toBe("root:insurance");
    expect(result.path.map((grant) => grant.id)).toEqual([
      "root-to-clearinghouse",
      "clearinghouse-to-agent"
    ]);
  });

  it("rejects authority outside the delegated namespace", () => {
    expect(resolveAuthority(graph, { ...query, predicate: "soc2.report.type" }).authorized).toBe(false);
  });

  it("rejects stale grants", () => {
    expect(resolveAuthority(graph, { ...query, at: "2031-01-01T00:00:00.000Z" }).authorized).toBe(false);
  });
});


describe("authority traversal regressions", () => {
  it("tries a shorter route after a shared ancestor exceeds its delegation depth", () => {
    const grant = (id: string, grantor: string, grantee: string) => ({
      id, grantor, grantee, actions: ["issue" as const], predicatePatterns: ["insurance.*"], mayDelegate: true
    });
    const diamond: AuthorityGraph = { acceptedRoots: ["root"], grants: [
      grant("long-leaf", "middle", "issuer:agent"),
      grant("long-parent", "shared", "middle"),
      grant("short", "shared", "issuer:agent"),
      { ...grant("root", "root", "shared"), maxDelegationDepth: 1 }
    ] };
    expect(resolveAuthority(diamond, query).path.map(({ id }) => id)).toEqual(["root", "short"]);
  });

  it("rejects missing jurisdiction when a grant is jurisdiction-limited", () => {
    const scoped = { ...graph, grants: graph.grants.map((grant) => ({ ...grant, jurisdiction: "US" })) };
    expect(resolveAuthority(scoped, query).authorized).toBe(false);
    expect(resolveAuthority(scoped, { ...query, jurisdiction: "US" }).authorized).toBe(true);
  });

  it("fails closed on invalid evaluation or grant dates", () => {
    expect(resolveAuthority(graph, { ...query, at: "invalid" }).authorized).toBe(false);
    const malformed = { ...graph, grants: graph.grants.map((grant) => ({ ...grant, validUntil: "invalid" })) };
    expect(resolveAuthority(malformed, query).authorized).toBe(false);
  });

  it("terminates on cycles without accepted roots", () => {
    const cyclic = { ...graph, acceptedRoots: [], grants: [...graph.grants,
      { ...graph.grants[0]!, grantor: "issuer:agent", grantee: "root:insurance" }
    ] };
    expect(resolveAuthority(cyclic, query).authorized).toBe(false);
  });
});
