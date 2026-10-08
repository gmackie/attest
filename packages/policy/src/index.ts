import { resolveAttestationAuthority, type AuthorityResolution } from "@attest/authority";
import {
  asBoolean,
  asDate,
  asInteger,
  asString,
  type Attestation,
  type AttestationValue,
  type AuthorityGraph,
  type RootId,
  type SubjectBinding
} from "@attest/domain";
import { Effect } from "effect";

export type ClaimOperator = "exists" | "eq" | "gte" | "lte";

export type ClaimRequirement = Readonly<{
  kind: "claim";
  id: string;
  label: string;
  predicate: string;
  operator: ClaimOperator;
  expected?: AttestationValue;
}>;

export type CountRequirement = Readonly<{
  kind: "count";
  id: string;
  label: string;
  predicate: string;
  minimum: number;
  distinctBy?: "attestation" | `context:${string}`;
}>;

export type AllRequirement = Readonly<{
  kind: "all";
  id: string;
  children: readonly RequirementNode[];
}>;

export type AnyRequirement = Readonly<{
  kind: "any";
  id: string;
  children: readonly RequirementNode[];
}>;

export type RequirementNode = ClaimRequirement | CountRequirement | AllRequirement | AnyRequirement;

export type RequirementProfile = Readonly<{
  id: string;
  name: string;
  description: string;
  subject: SubjectBinding;
  acceptedRoots: readonly RootId[];
  jurisdiction?: string;
  evaluatedAt: string;
  root: RequirementNode;
}>;

export type LeafEvaluation = Readonly<{
  id: string;
  label: string;
  predicate: string;
  satisfied: boolean;
  witnessIds: readonly string[];
  authorityPaths: readonly (readonly string[])[];
  reason?: string;
}>;

export type PolicyEvaluation = Readonly<{
  policyId: string;
  satisfied: boolean;
  witnessIds: readonly string[];
  leaves: readonly LeafEvaluation[];
  privacyCost: number;
}>;

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

const usableAt = (attestation: Attestation, subject: string, at: Date): boolean => {
  if (attestation.subject !== subject || attestation.status !== "active") return false;
  if (attestation.validFrom !== undefined && new Date(attestation.validFrom) > at) return false;
  if (attestation.validUntil !== undefined && new Date(attestation.validUntil) < at) return false;
  return true;
};

const sameUnit = (actual: AttestationValue, expected: AttestationValue): boolean =>
  actual.kind !== "integer" || expected.kind !== "integer" || expected.unit === undefined || actual.unit === expected.unit;

const compare = (actual: AttestationValue, operator: ClaimOperator, expected?: AttestationValue): boolean => {
  if (operator === "exists") return true;
  if (expected === undefined || actual.kind !== expected.kind || !sameUnit(actual, expected)) return false;
  if (operator === "eq") {
    if (actual.kind === "integer") return asInteger(actual) === asInteger(expected);
    if (actual.kind === "boolean") return asBoolean(actual) === asBoolean(expected);
    if (actual.kind === "string") return asString(actual) === asString(expected);
    return asDate(actual)?.getTime() === asDate(expected)?.getTime();
  }
  if (actual.kind === "integer") {
    const left = asInteger(actual);
    const right = asInteger(expected);
    if (left === undefined || right === undefined) return false;
    return operator === "gte" ? left >= right : left <= right;
  }
  if (actual.kind === "date") {
    const left = asDate(actual)?.getTime();
    const right = asDate(expected)?.getTime();
    if (left === undefined || right === undefined) return false;
    return operator === "gte" ? left >= right : left <= right;
  }
  return false;
};

const candidateAuthority = (
  graph: AuthorityGraph,
  attestation: Attestation,
  predicate: string,
  profile: RequirementProfile
): AuthorityResolution =>
  resolveAttestationAuthority(graph, attestation, predicate, profile.evaluatedAt, profile.acceptedRoots);

const evaluateClaim = (
  node: ClaimRequirement,
  attestations: readonly Attestation[],
  graph: AuthorityGraph,
  profile: RequirementProfile
): PolicyEvaluation => {
  const at = new Date(profile.evaluatedAt);
  const failures: string[] = [];
  for (const attestation of attestations) {
    if (!usableAt(attestation, profile.subject, at)) continue;
    const value = attestation.claims[node.predicate];
    if (value === undefined || !compare(value, node.operator, node.expected)) continue;
    const authority = candidateAuthority(graph, attestation, node.predicate, profile);
    if (!authority.authorized) {
      failures.push(authority.reason ?? `Issuer ${attestation.issuer} is not accepted`);
      continue;
    }
    const leaf: LeafEvaluation = {
      id: node.id,
      label: node.label,
      predicate: node.predicate,
      satisfied: true,
      witnessIds: [attestation.id],
      authorityPaths: [authority.path.map((grant) => grant.id)]
    };
    return { policyId: profile.id, satisfied: true, witnessIds: [attestation.id], leaves: [leaf], privacyCost: 1 };
  }
  const leaf: LeafEvaluation = {
    id: node.id,
    label: node.label,
    predicate: node.predicate,
    satisfied: false,
    witnessIds: [],
    authorityPaths: [],
    reason: failures[0] ?? `No current authorized attestation satisfies ${node.label}`
  };
  return { policyId: profile.id, satisfied: false, witnessIds: [], leaves: [leaf], privacyCost: Number.POSITIVE_INFINITY };
};

const distinctKey = (attestation: Attestation, distinctBy: CountRequirement["distinctBy"]): string => {
  if (distinctBy === undefined || distinctBy === "attestation") return attestation.id;
  const key = distinctBy.slice("context:".length);
  const value = attestation.context?.[key];
  if (value === undefined) return attestation.id;
  return `${value.kind}:${"value" in value ? String(value.value) : ""}`;
};

const evaluateCount = (
  node: CountRequirement,
  attestations: readonly Attestation[],
  graph: AuthorityGraph,
  profile: RequirementProfile
): PolicyEvaluation => {
  const at = new Date(profile.evaluatedAt);
  const accepted: Array<{ attestation: Attestation; authority: AuthorityResolution }> = [];
  const seen = new Set<string>();
  for (const attestation of attestations) {
    if (!usableAt(attestation, profile.subject, at) || attestation.claims[node.predicate] === undefined) continue;
    const key = distinctKey(attestation, node.distinctBy);
    if (seen.has(key)) continue;
    const authority = candidateAuthority(graph, attestation, node.predicate, profile);
    if (!authority.authorized) continue;
    seen.add(key);
    accepted.push({ attestation, authority });
  }
  const selected = accepted.slice(0, node.minimum);
  const satisfied = accepted.length >= node.minimum;
  const leaf: LeafEvaluation = {
    id: node.id,
    label: node.label,
    predicate: node.predicate,
    satisfied,
    witnessIds: selected.map(({ attestation }) => attestation.id),
    authorityPaths: selected.map(({ authority }) => authority.path.map((grant) => grant.id)),
    ...(satisfied ? {} : { reason: `Found ${accepted.length}; requires at least ${node.minimum}` })
  };
  return {
    policyId: profile.id,
    satisfied,
    witnessIds: leaf.witnessIds,
    leaves: [leaf],
    privacyCost: satisfied ? leaf.witnessIds.length : Number.POSITIVE_INFINITY
  };
};

const combineAll = (evaluations: readonly PolicyEvaluation[], profile: RequirementProfile): PolicyEvaluation => {
  const satisfied = evaluations.every((evaluation) => evaluation.satisfied);
  const witnessIds = unique(evaluations.flatMap((evaluation) => evaluation.witnessIds));
  return {
    policyId: profile.id,
    satisfied,
    witnessIds,
    leaves: evaluations.flatMap((evaluation) => evaluation.leaves),
    privacyCost: satisfied ? witnessIds.length : Number.POSITIVE_INFINITY
  };
};

const chooseAny = (evaluations: readonly PolicyEvaluation[], profile: RequirementProfile): PolicyEvaluation => {
  const successful = evaluations.filter((evaluation) => evaluation.satisfied);
  if (successful.length === 0) return combineAll(evaluations, profile);
  return successful.reduce((best, candidate) => candidate.privacyCost < best.privacyCost ? candidate : best);
};

const evaluateNode = (
  node: RequirementNode,
  attestations: readonly Attestation[],
  graph: AuthorityGraph,
  profile: RequirementProfile
): PolicyEvaluation => {
  switch (node.kind) {
    case "claim": return evaluateClaim(node, attestations, graph, profile);
    case "count": return evaluateCount(node, attestations, graph, profile);
    case "all": return combineAll(node.children.map((child) => evaluateNode(child, attestations, graph, profile)), profile);
    case "any": return chooseAny(node.children.map((child) => evaluateNode(child, attestations, graph, profile)), profile);
  }
};

export const evaluatePolicy = (
  profile: RequirementProfile,
  attestations: readonly Attestation[],
  graph: AuthorityGraph
): PolicyEvaluation => evaluateNode(profile.root, attestations, graph, profile);

export const evaluatePolicyEffect = (
  profile: RequirementProfile,
  attestations: readonly Attestation[],
  graph: AuthorityGraph
) => Effect.sync(() => evaluatePolicy(profile, attestations, graph));

export const claim = (
  id: string,
  label: string,
  predicate: string,
  operator: ClaimOperator,
  expected?: AttestationValue
): ClaimRequirement => ({ kind: "claim", id, label, predicate, operator, ...(expected === undefined ? {} : { expected }) });

export const exists = (id: string, label: string, predicate: string) => claim(id, label, predicate, "exists");
export const eq = (id: string, label: string, predicate: string, expected: AttestationValue) => claim(id, label, predicate, "eq", expected);
export const gte = (id: string, label: string, predicate: string, expected: AttestationValue) => claim(id, label, predicate, "gte", expected);
export const lte = (id: string, label: string, predicate: string, expected: AttestationValue) => claim(id, label, predicate, "lte", expected);
export const countAtLeast = (
  id: string,
  label: string,
  predicate: string,
  minimum: number,
  distinctBy?: CountRequirement["distinctBy"]
): CountRequirement => ({ kind: "count", id, label, predicate, minimum, ...(distinctBy === undefined ? {} : { distinctBy }) });
export const all = (id: string, ...children: readonly RequirementNode[]): AllRequirement => ({ kind: "all", id, children });
export const any = (id: string, ...children: readonly RequirementNode[]): AnyRequirement => ({ kind: "any", id, children });
