import type {
  Attestation,
  AuthorityAction,
  AuthorityGrant,
  AuthorityGraph,
  IssuerId,
  RootId,
  SchemaId
} from "@attest/domain";
import { Effect } from "effect";

export type AuthorityQuery = Readonly<{
  issuer: IssuerId;
  action: AuthorityAction;
  predicate: string;
  schema: SchemaId;
  at: string;
  jurisdiction?: string;
  acceptedRoots?: readonly RootId[];
}>;

export type AuthorityResolution = Readonly<{
  authorized: boolean;
  root?: RootId;
  path: readonly AuthorityGrant[];
  reason?: string;
}>;

export const matchesPattern = (pattern: string, value: string): boolean => {
  if (pattern === "*") return true;
  if (!pattern.endsWith("*")) return pattern === value;
  return value.startsWith(pattern.slice(0, -1));
};

const activeAt = (grant: AuthorityGrant, instant: Date): boolean => {
  if (grant.validFrom !== undefined && new Date(grant.validFrom) > instant) return false;
  if (grant.validUntil !== undefined && new Date(grant.validUntil) < instant) return false;
  return true;
};

const grantMatches = (grant: AuthorityGrant, query: AuthorityQuery): boolean => {
  const instant = new Date(query.at);
  if (!grant.actions.includes(query.action)) return false;
  if (!grant.predicatePatterns.some((pattern) => matchesPattern(pattern, query.predicate))) return false;
  if (grant.schemas !== undefined && !grant.schemas.includes(query.schema)) return false;
  if (query.jurisdiction !== undefined && grant.jurisdiction !== undefined && grant.jurisdiction !== query.jurisdiction) return false;
  return activeAt(grant, instant);
};

/**
 * Resolve a scoped chain from an issuer to a verifier-selected root.
 * Every edge must independently cover the requested action/predicate/schema.
 */
export const resolveAuthority = (graph: AuthorityGraph, query: AuthorityQuery): AuthorityResolution => {
  const roots = new Set(query.acceptedRoots ?? graph.acceptedRoots);
  if (roots.has(query.issuer)) return { authorized: true, root: query.issuer, path: [] };

  const visited = new Set<IssuerId>();
  const walk = (issuer: IssuerId, lowerPath: readonly AuthorityGrant[]): AuthorityResolution | undefined => {
    if (visited.has(issuer)) return undefined;
    visited.add(issuer);

    for (const grant of graph.grants) {
      if (grant.grantee !== issuer || !grantMatches(grant, query)) continue;
      const isDelegatingThroughGrantee = lowerPath.length > 0;
      if (isDelegatingThroughGrantee && !grant.mayDelegate) continue;
      if (grant.maxDelegationDepth !== undefined && lowerPath.length > grant.maxDelegationDepth) continue;

      const path = [grant, ...lowerPath] as const;
      if (roots.has(grant.grantor)) {
        return { authorized: true, root: grant.grantor, path };
      }
      const parent = walk(grant.grantor, path);
      if (parent !== undefined) return parent;
    }
    return undefined;
  };

  return (
    walk(query.issuer, []) ?? {
      authorized: false,
      path: [],
      reason: `No accepted authority path permits ${query.issuer} to ${query.action} ${query.predicate}`
    }
  );
};

export const actionForAttestation = (attestation: Attestation): AuthorityAction => {
  switch (attestation.assurance) {
    case "direct-observation": return "observe";
    case "certification": return "certify";
    case "statutory-license": return "license";
    default: return "issue";
  }
};

export const resolveAttestationAuthority = (
  graph: AuthorityGraph,
  attestation: Attestation,
  predicate: string,
  at: string,
  acceptedRoots?: readonly RootId[]
): AuthorityResolution =>
  resolveAuthority(graph, {
    issuer: attestation.issuer,
    action: actionForAttestation(attestation),
    predicate,
    schema: attestation.schema,
    at,
    ...(attestation.jurisdiction === undefined ? {} : { jurisdiction: attestation.jurisdiction }),
    ...(acceptedRoots === undefined ? {} : { acceptedRoots })
  });

export const resolveAuthorityEffect = (graph: AuthorityGraph, query: AuthorityQuery) =>
  Effect.sync(() => resolveAuthority(graph, query));
