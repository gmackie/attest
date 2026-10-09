import type { Industry, IndustryRule, IndustryRun } from "./industries";
export type ContractLevel = "standard" | "enhanced" | "critical";
export const contractLevels = [
  { value: "standard", label: "Standard approval" },
  { value: "enhanced", label: "Enhanced assurance" },
  { value: "critical", label: "Critical engagement" },
] as const;
const contexts = {
  healthcare: {
    title: "Clinical Placement Assurance Agreement",
    purpose: "Permission to begin an assigned nursing placement",
    scope:
      "The named clinician and the specified placement decision only; no privileges at other facilities are inferred.",
    retention:
      "The verifier receives a request-bound proof bundle. Clinical records and internal review notes remain with their originating institutions.",
    event:
      "A suspension, changed fitness status or expired credential requires a new evaluation before the next placement.",
    exclusion:
      "This demonstration does not grant clinical privileges or replace human credentialing review.",
  },
  education: {
    title: "Graduate Admission & Funding Assurance Agreement",
    purpose: "Conditional eligibility for the upcoming graduate intake",
    scope:
      "The named applicant and this admissions request only. Academic eligibility does not imply visa eligibility or a guaranteed scholarship payment.",
    retention:
      "The admissions verifier may retain the proof and decision receipt; full transcripts, bank statements and internal notes remain at source.",
    event:
      "A withdrawn award, changed funding commitment or expired assessment requires a new presentation.",
    exclusion:
      "Admission offers, enrollment deadlines, immigration checks and award disbursement are outside the executable policy.",
  },
  logistics: {
    title: "Temperature-Controlled Shipment Release Agreement",
    purpose: "Acceptance of the named shipment at the receiving pharmacy",
    scope:
      "The named shipment lot only. Calibration and release assertions refer to that shipment; no other lot is covered.",
    retention:
      "The receiver retains a verification receipt. Raw telemetry and laboratory workpapers remain with the monitoring and testing institutions.",
    event:
      "A seal break, quality deviation or new temperature excursion requires re-evaluation before release.",
    exclusion:
      "The demo does not establish sensor truth, physical custody or legal title to goods.",
  },
} as const;
export type ApprovalContract = {
  id: string;
  version: string;
  level: ContractLevel;
  title: string;
  purpose: string;
  scope: string;
  retention: string;
  event: string;
  exclusion: string;
  effectiveAt: string;
  logic: string;
};
export const contractFor = (industry: Industry): ApprovalContract =>
  industry.contract ?? {
    ...contexts[industry.id],
    id: `agreement:${industry.id}:standard`,
    version: "1.0",
    level: "standard",
    effectiveAt: "2026-10-08",
    logic:
      "All clauses must pass. Each source proves its own claims; no credential may substitute for another issuer or subject.",
  };
export function withContract(base: Industry, level: ContractLevel): Industry {
  const overrides: Record<string, number | string> =
    level === "standard"
      ? {}
      : base.id === "healthcare"
        ? {
            "employer.experience": level === "critical" ? 5 : 3,
            "training-center.hours": level === "critical" ? 40 : 24,
            "license-board.validThrough":
              level === "critical" ? "2027-12-31" : "2027-06-30",
            "occupational.validThrough":
              level === "critical" ? "2027-12-31" : "2027-06-30",
          }
        : base.id === "education"
          ? {
              "university.gpa": level === "critical" ? 3.8 : 3.5,
              "assessment.score": level === "critical" ? 115 : 110,
              "foundation.award": level === "critical" ? 25000 : 20000,
              "prerequisites.credits": level === "critical" ? 48 : 30,
              "funding.available": level === "critical" ? 60000 : 40000,
            }
          : {
              "sensor.minimum": level === "critical" ? 4 : 3,
              "sensor.maximum": level === "critical" ? 5 : 7,
              "carrier.handoffs": level === "critical" ? 1 : 2,
              "calibration.validThrough":
                level === "critical" ? "2027-12-31" : "2027-03-31",
            };
  const rules = base.rules.map((r) => {
    const value = overrides[`${r.source}.${r.field}`];
    return value === undefined
      ? r
      : {
          ...r,
          value,
          label: `${base.sources.find((s) => s.id === r.source)!.fields.find((f) => f.id === r.field)!.label} ${r.operator === "gte" ? "≥" : "≤"} ${value}`,
        };
  });
  return {
    ...base,
    rules,
    contract: {
      ...contexts[base.id],
      id: `agreement:${base.id}:${level}`,
      version: "1.0",
      level,
      effectiveAt: "2026-10-08",
      logic:
        "ALL clauses are mandatory. No averaging, issuer substitution, or combining facts across subjects is permitted.",
    },
  };
}
export const clauseId = (industry: Industry, rule: IndustryRule) =>
  `${industry.id.toUpperCase().slice(0, 3)}-${String(industry.rules.indexOf(rule) + 1).padStart(2, "0")}`;
export function contractDocument(industry: Industry) {
  return {
    ...contractFor(industry),
    parties: {
      holder: industry.holder,
      verifier: industry.verifier,
      subject: industry.subject,
    },
    clauses: industry.rules.map((rule) => ({
      id: clauseId(industry, rule),
      issuer: industry.sources.find((s) => s.id === rule.source)!.name,
      schema: industry.sources.find((s) => s.id === rule.source)!.schema,
      predicate: rule.field,
      operator: rule.operator,
      required: rule.value,
      statement: `The accepted issuer attests that ${rule.field} for ${industry.subject} ${rule.operator === "eq" ? "equals" : rule.operator === "gte" ? "is at least" : "is at most"} ${String(rule.value)}.`,
      enforcement:
        "Issuer-specific GPC constraint in private mode; authenticated comparison in disclosed mode.",
    })),
  };
}
export function statementDocument(run: IndustryRun, sourceId: string) {
  const c = run.issued.find((c) => c.claims.issuer === sourceId);
  return c
    ? {
        issuer: run.industry.sources.find((s) => s.id === sourceId)!.name,
        subject: c.claims.subject,
        schema: c.claims.schema,
        assertion: Object.entries(c.claims.fields).map(
          ([key, value]) => `${key} = ${String(value)}`,
        ),
        signedRecord: c,
        meaning:
          "The signature authenticates these assertions. It does not independently establish real-world truth.",
      }
    : null;
}
