import {
  booleanValue,
  dateValue,
  integerValue,
  stringValue,
  type Attestation,
  type AuthorityGraph
} from "@attest/domain";
import { all, eq, gte, type RequirementProfile } from "@attest/policy";

export const DEMO_SUBJECT = "subject:acme-industrial-controls";
export const DEMO_INSURANCE_ISSUER_PRIVATE_KEY = "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8";

export type DemoThresholds = Readonly<{
  aggregateMinimumUsd: bigint;
  perOccurrenceMinimumUsd: bigint;
  projectEnd: string;
}>;

export const defaultThresholds: DemoThresholds = {
  aggregateMinimumUsd: 2_000_000n,
  perOccurrenceMinimumUsd: 1_000_000n,
  projectEnd: "2027-06-30T00:00:00.000Z"
};

export const demoAuthorityGraph: AuthorityGraph = {
  acceptedRoots: ["root:insurance", "root:aicpa", "root:iso-accreditation"],
  grants: [
    {
      id: "grant:carrier",
      grantor: "root:insurance",
      grantee: "issuer:carrier",
      actions: ["issue"],
      predicatePatterns: ["insurance.*"],
      schemas: ["attest:insurance:cgl:v1"],
      validUntil: "2030-01-01T00:00:00.000Z",
      mayDelegate: false
    },
    {
      id: "grant:cpa",
      grantor: "root:aicpa",
      grantee: "issuer:cpa-firm",
      actions: ["issue"],
      predicatePatterns: ["soc2.*"],
      schemas: ["attest:soc2:v1"],
      validUntil: "2030-01-01T00:00:00.000Z",
      mayDelegate: false
    },
    {
      id: "grant:iso-certifier",
      grantor: "root:iso-accreditation",
      grantee: "issuer:iso-certifier",
      actions: ["certify"],
      predicatePatterns: ["iso9001.*"],
      schemas: ["attest:iso9001:v1"],
      validUntil: "2030-01-01T00:00:00.000Z",
      mayDelegate: false
    }
  ]
};

export const demoAttestations: readonly Attestation[] = [
  {
    id: "att:insurance:acme:2027",
    schema: "attest:insurance:cgl:v1",
    subject: DEMO_SUBJECT,
    issuer: "issuer:carrier",
    persona: "persona:compliance",
    claims: {
      "insurance.cgl.aggregate": integerValue(5_000_000, "USD"),
      "insurance.cgl.perOccurrence": integerValue(2_000_000, "USD"),
      "insurance.additionalInsured": booleanValue(true),
      "insurance.waiverOfSubrogation": booleanValue(true),
      "insurance.validUntil": dateValue("2027-12-31T23:59:59.000Z")
    },
    context: {
      "entity.role": stringValue("contracting-entity"),
      "policy.kind": stringValue("commercial-general-liability")
    },
    evidence: [{
      id: "evidence:policy:acme-2027",
      kind: "document-commitment",
      commitment: "0x9c88evidencecommitment",
      mediaType: "application/pdf",
      source: "synthetic carrier policy record",
      observedAt: "2026-10-07T12:00:00.000Z"
    }],
    assurance: "authoritative-source",
    issuedAt: "2026-10-07T12:00:00.000Z",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-12-31T23:59:59.000Z",
    status: "active"
  },
  {
    id: "att:soc2:acme:2026",
    schema: "attest:soc2:v1",
    subject: DEMO_SUBJECT,
    issuer: "issuer:cpa-firm",
    persona: "persona:compliance",
    claims: {
      "soc2.report.type": stringValue("type-ii"),
      "soc2.periodMonths": integerValue(12, "months"),
      "soc2.criteria.security": booleanValue(true),
      "soc2.materialExceptions": integerValue(0),
      "soc2.reportIssuedAt": dateValue("2026-09-15T00:00:00.000Z")
    },
    evidence: [{
      id: "evidence:soc2:2026",
      kind: "assessment",
      commitment: "0x7f12soc2reportcommitment",
      mediaType: "application/pdf",
      source: "synthetic CPA examination report",
      observedAt: "2026-09-15T00:00:00.000Z"
    }],
    assurance: "authoritative-source",
    issuedAt: "2026-09-15T00:00:00.000Z",
    validUntil: "2027-09-15T00:00:00.000Z",
    status: "active"
  },
  {
    id: "att:iso9001:acme:2026",
    schema: "attest:iso9001:v1",
    subject: DEMO_SUBJECT,
    issuer: "issuer:iso-certifier",
    persona: "persona:compliance",
    claims: {
      "iso9001.current": booleanValue(true),
      "iso9001.edition": stringValue("2015"),
      "iso9001.scope": stringValue("manufacturing-industrial-controls"),
      "iso9001.validUntil": dateValue("2029-08-31T23:59:59.000Z")
    },
    evidence: [{
      id: "evidence:iso9001:2026",
      kind: "native-record",
      commitment: "0x51d4iso9001certificatecommitment",
      source: "synthetic certification-body record",
      observedAt: "2026-09-01T00:00:00.000Z"
    }],
    assurance: "certification",
    issuedAt: "2026-09-01T00:00:00.000Z",
    validUntil: "2029-08-31T23:59:59.000Z",
    status: "active"
  }
] as const;

export const createSupplierPolicy = (thresholds: DemoThresholds = defaultThresholds): RequirementProfile => ({
  id: "policy:project-817",
  name: "Project 817 supplier assurance",
  description: "Insurance, SOC 2 and ISO 9001 assurance without disclosure of source records or exact limits.",
  subject: DEMO_SUBJECT,
  acceptedRoots: demoAuthorityGraph.acceptedRoots,
  evaluatedAt: "2026-10-07T18:00:00.000Z",
  root: all(
    "supplier-assurance",
    gte(
      "cgl-aggregate",
      `CGL aggregate ≥ $${Number(thresholds.aggregateMinimumUsd).toLocaleString("en-US")}`,
      "insurance.cgl.aggregate",
      integerValue(thresholds.aggregateMinimumUsd, "USD")
    ),
    gte(
      "cgl-occurrence",
      `CGL per occurrence ≥ $${Number(thresholds.perOccurrenceMinimumUsd).toLocaleString("en-US")}`,
      "insurance.cgl.perOccurrence",
      integerValue(thresholds.perOccurrenceMinimumUsd, "USD")
    ),
    eq("additional-insured", "Additional insured supported", "insurance.additionalInsured", booleanValue(true)),
    eq("waiver", "Waiver of subrogation supported", "insurance.waiverOfSubrogation", booleanValue(true)),
    gte("coverage-date", "Coverage valid through project end", "insurance.validUntil", dateValue(thresholds.projectEnd)),
    eq("soc2-type", "SOC 2 Type II", "soc2.report.type", stringValue("type-ii")),
    gte("soc2-period", "SOC 2 period ≥ 6 months", "soc2.periodMonths", integerValue(6, "months")),
    eq("soc2-security", "Security criterion in scope", "soc2.criteria.security", booleanValue(true)),
    eq("soc2-exceptions", "No material SOC 2 exceptions", "soc2.materialExceptions", integerValue(0)),
    eq("iso-current", "ISO 9001 certification current", "iso9001.current", booleanValue(true)),
    eq("iso-scope", "ISO 9001 scope covers industrial-controls manufacturing", "iso9001.scope", stringValue("manufacturing-industrial-controls")),
    gte("iso-date", "ISO 9001 valid through project end", "iso9001.validUntil", dateValue(thresholds.projectEnd))
  )
});
