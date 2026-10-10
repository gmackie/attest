export type AttestationId = string;
export type SubjectBinding = string;
export type IssuerId = string;
export type Predicate = string;
export type SchemaId = string;
export type RootId = string;
export type PersonaId = string;

export type IntegerValue = Readonly<{
  kind: "integer";
  value: string;
  unit?: string;
}>;

export type BooleanValue = Readonly<{
  kind: "boolean";
  value: boolean;
}>;

export type StringValue = Readonly<{
  kind: "string";
  value: string;
}>;

export type DateValue = Readonly<{
  kind: "date";
  value: string;
}>;

export type AttestationValue = IntegerValue | BooleanValue | StringValue | DateValue;

export const integerValue = (value: bigint | number, unit?: string): IntegerValue => ({
  kind: "integer",
  value: BigInt(value).toString(),
  ...(unit === undefined ? {} : { unit })
});

export const booleanValue = (value: boolean): BooleanValue => ({ kind: "boolean", value });
export const stringValue = (value: string): StringValue => ({ kind: "string", value });
export const dateValue = (value: string | Date): DateValue => ({
  kind: "date",
  value: typeof value === "string" ? value : value.toISOString()
});

export const asInteger = (value: AttestationValue): bigint | undefined =>
  value.kind === "integer" ? BigInt(value.value) : undefined;

export const asBoolean = (value: AttestationValue): boolean | undefined =>
  value.kind === "boolean" ? value.value : undefined;

export const asString = (value: AttestationValue): string | undefined =>
  value.kind === "string" ? value.value : undefined;

export const asDate = (value: AttestationValue): Date | undefined =>
  value.kind === "date" ? new Date(value.value) : undefined;

export type EvidenceRef = Readonly<{
  id: string;
  kind: "document-commitment" | "registry-record" | "native-record" | "assessment";
  commitment: string;
  mediaType?: string;
  source?: string;
  observedAt?: string;
}>;

export type AssuranceBasis =
  | "self-asserted"
  | "direct-observation"
  | "organization-record"
  | "authoritative-source"
  | "assessment"
  | "certification"
  | "statutory-license";

export type AttestationStatus = "active" | "revoked" | "superseded";

/**
 * A coherent issuer-signed assertion fragment. Claims share one subject, issuer,
 * evidence basis and validity context so individually valid facts cannot be mixed
 * across unrelated policies, entities or engagements.
 */
export type Attestation = Readonly<{
  id: AttestationId;
  schema: SchemaId;
  subject: SubjectBinding;
  issuer: IssuerId;
  persona?: PersonaId;
  claims: Readonly<Record<Predicate, AttestationValue>>;
  context?: Readonly<Record<string, AttestationValue>>;
  evidence: readonly EvidenceRef[];
  assurance: AssuranceBasis;
  issuedAt: string;
  validFrom?: string;
  validUntil?: string;
  jurisdiction?: string;
  status: AttestationStatus;
}>;

export type AuthorityAction = "issue" | "observe" | "certify" | "license" | "map";

export type AuthorityGrant = Readonly<{
  id: string;
  grantor: IssuerId;
  grantee: IssuerId;
  actions: readonly AuthorityAction[];
  predicatePatterns: readonly string[];
  schemas?: readonly SchemaId[];
  jurisdiction?: string;
  validFrom?: string;
  validUntil?: string;
  mayDelegate: boolean;
  maxDelegationDepth?: number;
}>;

export type AuthorityGraph = Readonly<{
  acceptedRoots: readonly RootId[];
  grants: readonly AuthorityGrant[];
}>;

export type Persona = Readonly<{
  id: PersonaId;
  label: string;
  allowedPredicatePatterns: readonly string[];
  identityDisclosure: "none" | "predicate-only" | "selective" | "full";
}>;

export type EvidenceRecord = Readonly<{
  attestation: Attestation;
  importedAt: string;
  sourcePersona?: PersonaId;
}>;

export type VerificationReceipt = Readonly<{
  id: string;
  policyId: string;
  policyCommitment: string;
  evidenceRoot: string;
  proofCommitment: string;
  subjectNullifier?: string;
  satisfied: boolean;
  verifiedAt: string;
}>;
