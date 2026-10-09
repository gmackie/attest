import { contractDocument, type ApprovalContract } from "./contracts";
import {
  issueCriteriaPod,
  proveCriteria,
  verifyCriteria,
  type CriteriaRequest,
  type GpcProofEnvelope,
} from "@attest/proofs";
import { Effect } from "effect";
import { POD, deriveSignerPublicKey } from "@pcd/pod";
import { canonicalJson, commitValue } from "@attest/core";

export type IndustryId = "healthcare" | "education" | "logistics";
export type FieldValue = string | number | boolean;
export type SourceField = Readonly<{
  id: string;
  label: string;
  type: "text" | "number" | "boolean" | "date";
  value: FieldValue;
  unit?: string;
}>;
export type IndustrySource = Readonly<{
  id: string;
  name: string;
  short: string;
  role: string;
  system: string;
  schema: string;
  fields: readonly SourceField[];
}>;
export type IndustryRule = Readonly<{
  source: string;
  field: string;
  label: string;
  operator: "eq" | "gte" | "lte";
  value: FieldValue;
}>;
export type Industry = Readonly<{
  contract?: ApprovalContract;
  id: IndustryId;
  name: string;
  headline: string;
  description: string;
  color: string;
  holder: string;
  subject: string;
  verifier: string;
  purpose: string;
  sources: readonly IndustrySource[];
  rules: readonly IndustryRule[];
  failure: { source: string; field: string; value: FieldValue; label: string };
}>;
const baseIndustries: readonly Industry[] = [
  {
    id: "healthcare",
    name: "Healthcare",
    headline: "A nurse. Three credentials. One hiring decision.",
    description:
      "Follow a license, training record and work history from their original registries into a clinician’s wallet.",
    color: "teal",
    holder: "Jordan Lee",
    subject: "clinician:jordan-lee",
    verifier: "Willow Creek Hospital",
    purpose: "Nursing placement",
    sources: [
      {
        id: "license-board",
        name: "Aster Nursing Board",
        short: "AN",
        role: "Licensing authority",
        system: "Professional license registry",
        schema: "demo:nursing-license:v1",
        fields: [
          {
            id: "status",
            label: "License status",
            type: "text",
            value: "active",
          },
          {
            id: "validThrough",
            label: "Valid through",
            type: "date",
            value: "2027-12-31",
          },
        ],
      },
      {
        id: "training-center",
        name: "Pulse Training Institute",
        short: "PT",
        role: "Training provider",
        system: "Learning management system",
        schema: "demo:clinical-training:v1",
        fields: [
          {
            id: "blsCurrent",
            label: "Current life-support training",
            type: "boolean",
            value: true,
          },
          {
            id: "hours",
            label: "Training hours",
            type: "number",
            value: 24,
            unit: "hours",
          },
        ],
      },
      {
        id: "employer",
        name: "Harbor Community Clinic",
        short: "HC",
        role: "Previous employer",
        system: "Employment records",
        schema: "demo:work-history:v1",
        fields: [
          {
            id: "role",
            label: "Clinical role",
            type: "text",
            value: "registered nurse",
          },
          {
            id: "experience",
            label: "Years of experience",
            type: "number",
            value: 4,
            unit: "years",
          },
        ],
      },
    ],
    rules: [
      {
        source: "license-board",
        field: "status",
        label: "License is active",
        operator: "eq",
        value: "active",
      },
      {
        source: "license-board",
        field: "validThrough",
        label: "License current on Oct 8, 2026",
        operator: "gte",
        value: "2026-10-08",
      },
      {
        source: "training-center",
        field: "blsCurrent",
        label: "Life-support training current",
        operator: "eq",
        value: true,
      },
      {
        source: "training-center",
        field: "hours",
        label: "At least 16 training hours",
        operator: "gte",
        value: 16,
      },
      {
        source: "employer",
        field: "role",
        label: "Registered nurse role",
        operator: "eq",
        value: "registered nurse",
      },
      {
        source: "employer",
        field: "experience",
        label: "At least 2 years of experience",
        operator: "gte",
        value: 2,
      },
    ],
    failure: {
      source: "license-board",
      field: "validThrough",
      value: "2025-12-31",
      label: "Expired license",
    },
  },
  {
    id: "education",
    name: "Education",
    headline: "Credentials travel. Applications get simpler.",
    description:
      "Trace a degree, language assessment and scholarship award into an admissions decision.",
    color: "violet",
    holder: "Alex Morgan",
    subject: "student:alex-morgan",
    verifier: "Northbridge Graduate School",
    purpose: "Graduate admission",
    sources: [
      {
        id: "university",
        name: "Westhaven University",
        short: "WU",
        role: "Degree issuer",
        system: "Student information system",
        schema: "demo:degree:v1",
        fields: [
          {
            id: "degree",
            label: "Awarded degree",
            type: "text",
            value: "bachelor",
          },
          {
            id: "gpa",
            label: "Grade point average",
            type: "number",
            value: 3.7,
            unit: "of 4.0",
          },
        ],
      },
      {
        id: "assessment",
        name: "Lingua Assessment",
        short: "LA",
        role: "Assessment provider",
        system: "Exam results database",
        schema: "demo:language:v1",
        fields: [
          {
            id: "score",
            label: "Language score",
            type: "number",
            value: 112,
            unit: "of 120",
          },
          {
            id: "validThrough",
            label: "Result valid through",
            type: "date",
            value: "2027-08-31",
          },
        ],
      },
      {
        id: "foundation",
        name: "Brightpath Foundation",
        short: "BF",
        role: "Scholarship fund",
        system: "Award management system",
        schema: "demo:scholarship:v1",
        fields: [
          {
            id: "award",
            label: "Annual scholarship",
            type: "number",
            value: 20000,
            unit: "USD",
          },
          {
            id: "confirmed",
            label: "Funding confirmed",
            type: "boolean",
            value: true,
          },
        ],
      },
    ],
    rules: [
      {
        source: "university",
        field: "degree",
        label: "Bachelor’s degree awarded",
        operator: "eq",
        value: "bachelor",
      },
      {
        source: "university",
        field: "gpa",
        label: "GPA at least 3.0",
        operator: "gte",
        value: 3,
      },
      {
        source: "assessment",
        field: "score",
        label: "Language score at least 100",
        operator: "gte",
        value: 100,
      },
      {
        source: "assessment",
        field: "validThrough",
        label: "Assessment current on Oct 8, 2026",
        operator: "gte",
        value: "2026-10-08",
      },
      {
        source: "foundation",
        field: "award",
        label: "At least $15,000 confirmed funding",
        operator: "gte",
        value: 15000,
      },
      {
        source: "foundation",
        field: "confirmed",
        label: "Scholarship confirmed",
        operator: "eq",
        value: true,
      },
    ],
    failure: {
      source: "assessment",
      field: "score",
      value: 85,
      label: "Language score too low",
    },
  },
  {
    id: "logistics",
    name: "Cold-chain logistics",
    headline: "From sensor reading to shipment release.",
    description:
      "Follow temperature summaries, lab results and custody records as a cold-chain shipment moves between institutions.",
    color: "amber",
    holder: "Frostline Distribution",
    subject: "shipment:lot-4821",
    verifier: "Cedarway Pharmacy",
    purpose: "Shipment acceptance",
    sources: [
      {
        id: "sensor",
        name: "ThermoTrace Monitoring",
        short: "TM",
        role: "Monitoring provider",
        system: "Temperature telemetry archive",
        schema: "demo:temperature:v1",
        fields: [
          {
            id: "minimum",
            label: "Minimum recorded temperature",
            type: "number",
            value: 3,
            unit: "°C",
          },
          {
            id: "maximum",
            label: "Maximum recorded temperature",
            type: "number",
            value: 6,
            unit: "°C",
          },
        ],
      },
      {
        id: "laboratory",
        name: "Clearwell Laboratories",
        short: "CL",
        role: "Testing laboratory",
        system: "Laboratory information system",
        schema: "demo:lot-test:v1",
        fields: [
          {
            id: "passed",
            label: "Lot quality test passed",
            type: "boolean",
            value: true,
          },
          {
            id: "validThrough",
            label: "Lot expiry",
            type: "date",
            value: "2027-03-31",
          },
        ],
      },
      {
        id: "carrier",
        name: "Polar Route Transport",
        short: "PR",
        role: "Custody provider",
        system: "Shipment and custody ledger",
        schema: "demo:custody:v1",
        fields: [
          {
            id: "sealed",
            label: "Seal intact at handoff",
            type: "boolean",
            value: true,
          },
          {
            id: "handoffs",
            label: "Recorded custody handoffs",
            type: "number",
            value: 2,
            unit: "handoffs",
          },
        ],
      },
    ],
    rules: [
      {
        source: "sensor",
        field: "minimum",
        label: "Temperature stayed at or above 2°C",
        operator: "gte",
        value: 2,
      },
      {
        source: "sensor",
        field: "maximum",
        label: "Temperature stayed at or below 8°C",
        operator: "lte",
        value: 8,
      },
      {
        source: "laboratory",
        field: "passed",
        label: "Lot quality test passed",
        operator: "eq",
        value: true,
      },
      {
        source: "laboratory",
        field: "validThrough",
        label: "Lot current on Oct 8, 2026",
        operator: "gte",
        value: "2026-10-08",
      },
      {
        source: "carrier",
        field: "sealed",
        label: "Seal intact",
        operator: "eq",
        value: true,
      },
      {
        source: "carrier",
        field: "handoffs",
        label: "At most 3 custody handoffs",
        operator: "lte",
        value: 3,
      },
    ],
    failure: {
      source: "sensor",
      field: "maximum",
      value: 12,
      label: "Temperature excursion",
    },
  },
];
const additionalSources: Record<IndustryId, readonly IndustrySource[]> = {
  healthcare: [
    {
      id: "screening",
      name: "ClearPath Screening",
      short: "CS",
      role: "Credential screening",
      system: "Professional screening registry",
      schema: "demo:screening:v1",
      fields: [
        {
          id: "eligible",
          label: "Eligible for clinical placement",
          type: "boolean",
          value: true,
        },
        {
          id: "validThrough",
          label: "Screening valid through",
          type: "date",
          value: "2027-10-31",
        },
      ],
    },
    {
      id: "occupational",
      name: "Everwell Occupational Health",
      short: "EO",
      role: "Occupational health",
      system: "Fitness-for-duty records",
      schema: "demo:fitness:v1",
      fields: [
        {
          id: "cleared",
          label: "Fit for assigned duties",
          type: "boolean",
          value: true,
        },
        {
          id: "validThrough",
          label: "Clearance valid through",
          type: "date",
          value: "2027-06-30",
        },
      ],
    },
  ],
  education: [
    {
      id: "prerequisites",
      name: "Summit Course Registry",
      short: "SC",
      role: "Prerequisite assessment",
      system: "Course completion registry",
      schema: "demo:prerequisites:v1",
      fields: [
        {
          id: "credits",
          label: "Relevant course credits",
          type: "number",
          value: 36,
        },
        {
          id: "research",
          label: "Research methods completed",
          type: "boolean",
          value: true,
        },
      ],
    },
    {
      id: "funding",
      name: "Crescent Education Trust",
      short: "CE",
      role: "Financial capacity attestor",
      system: "Education funding attestations",
      schema: "demo:funding:v1",
      fields: [
        {
          id: "available",
          label: "Available education funding",
          type: "number",
          value: 45000,
          unit: "USD",
        },
        {
          id: "validThrough",
          label: "Funding confirmation valid through",
          type: "date",
          value: "2027-08-31",
        },
      ],
    },
  ],
  logistics: [
    {
      id: "calibration",
      name: "Precision Calibration Bureau",
      short: "PC",
      role: "Sensor calibration authority",
      system: "Calibration certificate registry",
      schema: "demo:calibration:v1",
      fields: [
        {
          id: "certified",
          label: "Sensor calibration certified",
          type: "boolean",
          value: true,
        },
        {
          id: "validThrough",
          label: "Calibration valid through",
          type: "date",
          value: "2027-05-31",
        },
      ],
    },
    {
      id: "origin",
      name: "Alpine Manufacturing QA",
      short: "AM",
      role: "Manufacturer release authority",
      system: "Batch release records",
      schema: "demo:release:v1",
      fields: [
        {
          id: "released",
          label: "Batch approved for release",
          type: "boolean",
          value: true,
        },
        {
          id: "deviations",
          label: "Unresolved quality deviations",
          type: "number",
          value: 0,
        },
      ],
    },
  ],
};
export const industries: readonly Industry[] = baseIndustries.map((i) => ({
  ...i,
  headline:
    i.id === "healthcare"
      ? "A nurse. Five credentials. One private decision."
      : i.headline,
  sources: [...i.sources, ...additionalSources[i.id]],
  rules: [
    ...i.rules,
    ...additionalSources[i.id].flatMap((source) =>
      source.fields.map((field) => ({
        source: source.id,
        field: field.id,
        label:
          field.type === "date"
            ? `${source.role}: current on Oct 8, 2026`
            : field.label,
        operator:
          field.type === "date" ||
          field.id === "credits" ||
          field.id === "available"
            ? ("gte" as const)
            : field.id === "deviations"
              ? ("lte" as const)
              : ("eq" as const),
        value:
          field.type === "date"
            ? "2026-10-08"
            : field.id === "credits"
              ? 24
              : field.id === "available"
                ? 30000
                : field.value,
      })),
    ),
  ],
}));

export const industrySteps = [
  {
    title: "Capture",
    verb: "Save source records",
    description:
      "Each institution receives only its own form fields. These are synthetic local source systems, not remote databases.",
  },
  {
    title: "Prepare",
    verb: "Prepare credential claims",
    description:
      "Each issuer validates types and maps approved source fields to its credential schema. Internal notes stay in the source system.",
  },
  {
    title: "Sign",
    verb: "Sign issuer credentials",
    description:
      "Each institution signs its own subject-bound credential with a distinct POD signing key. The signature authenticates claims; it cannot establish that entered data is true.",
  },
  {
    title: "Store",
    verb: "Deliver to the wallet",
    description:
      "The holder receives five credentials. Issuer copies stay in the source stores. No issuer receives another issuer’s source data.",
  },
  {
    title: "Present",
    verb: "Share signed credentials",
    description:
      "The holder signs a fresh verifier challenge and the credential-set commitment. These industry examples disclose all signed claims to the verifier; internal notes and secret keys stay local. This is not a zero-knowledge proof.",
  },
  {
    title: "Verify",
    verb: "Verify and decide",
    description:
      "The verifier independently checks expected issuer keys, schemas, subject and holder binding, the request challenge, and the policy. The decision follows the entered data.",
  },
  {
    title: "Anchor",
    verb: "Simulate receipt storage",
    description:
      "A local ledger illustration records receipt commitments and the claimed outcome. No blockchain transaction is sent; the contract does not run a cryptographic verifier.",
  },
] as const;
export type SourceInput = Readonly<{
  subject: string;
  internalNote: string;
  fields: Readonly<Record<string, FieldValue>>;
}>;
export type IndustryInputs = Readonly<Record<string, SourceInput>>;
export type CredentialClaims = Readonly<{
  id: string;
  issuer: string;
  schema: string;
  subject: string;
  holderPublicKey: string;
  fields: Readonly<Record<string, FieldValue>>;
}>;
export type IndustryCredential = Readonly<{
  claims: CredentialClaims;
  pod: ReturnType<POD["toJSON"]>;
}>;
export type IndustryCheck = Readonly<{
  label: string;
  satisfied: boolean;
  detail: string;
}>;
export type IndustryRun = Readonly<{
  id: string;
  industry: Industry;
  completed: number;
  privateMode: boolean;
  privatePods: readonly ReturnType<POD["toJSON"]>[];
  privateInbox: null | {
    proofs: readonly GpcProofEnvelope[];
    signature: ReturnType<POD["toJSON"]>;
  };
  holderSecret: string;
  holderPublicKey: string;
  challenge: string;
  inputs: IndustryInputs;
  raw: IndustryInputs;
  prepared: readonly CredentialClaims[];
  issued: readonly IndustryCredential[];
  wallet: readonly IndustryCredential[];
  inbox: null | {
    credentials: readonly IndustryCredential[];
    presentation: ReturnType<POD["toJSON"]>;
  };
  checks: readonly IndustryCheck[];
  receipt: null | {
    policyCommitment: string;
    proofCommitment: string;
    evidenceRoot: string;
    subjectNullifier: string;
    satisfied: boolean;
  };
  ledger: readonly {
    type: "VerificationRecorded (simulation)";
    receipt: NonNullable<IndustryRun["receipt"]>;
  }[];
}>;
export const defaultIndustryInputs = (industry: Industry): IndustryInputs =>
  Object.fromEntries(
    industry.sources.map((source) => [
      source.id,
      {
        subject: industry.subject,
        internalNote: `Internal review note for ${source.name}. Not included in the credential.`,
        fields: Object.fromEntries(
          source.fields.map((field) => [field.id, field.value]),
        ),
      },
    ]),
  );
// Deliberately public demonstration keys, unique across industry/source pairs.
const sourceKey = (industry: Industry, sourceId: string) => {
  const i = industries.findIndex((item) => item.id === industry.id);
  const j = industry.sources.findIndex((item) => item.id === sourceId);
  if (i < 0 || j < 0) throw new Error("Unknown issuer");
  return (1000 + i * 10 + j).toString(16).padStart(64, "0");
};
export const createIndustryRun = (
  industry: Industry,
  inputs = defaultIndustryInputs(industry),
  privateMode = false,
): IndustryRun => {
  const holderSecret = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const id = crypto.randomUUID();
  return {
    id,
    privateMode,
    privatePods: [],
    privateInbox: null,
    industry,
    completed: 0,
    holderSecret,
    holderPublicKey: deriveSignerPublicKey(holderSecret),
    challenge: `${industry.id}:${id}`,
    inputs: structuredClone(inputs),
    raw: {},
    prepared: [],
    issued: [],
    wallet: [],
    inbox: null,
    checks: [],
    receipt: null,
    ledger: [],
  };
};
export class IndustryError extends Error {
  readonly _tag = "IndustryError";
}
const validValue = (
  field: SourceField,
  value: unknown,
): value is FieldValue => {
  if (field.type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (field.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string" || !value.trim()) return false;
  if (field.type === "date")
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
    );
  return true;
};
export function authenticateIndustryCredential(
  credential: IndustryCredential,
  industry: Industry,
  source: IndustrySource,
  run: Pick<IndustryRun, "holderPublicKey">,
): boolean {
  try {
    const pod = POD.fromJSON(credential.pod);
    return (
      pod.verifySignature() &&
      pod.signerPublicKey ===
        deriveSignerPublicKey(sourceKey(industry, source.id)) &&
      pod.content.getValue("credential")?.value ===
        canonicalJson(credential.claims) &&
      credential.claims.issuer === source.id &&
      credential.claims.schema === source.schema &&
      credential.claims.subject === industry.subject &&
      credential.claims.holderPublicKey === run.holderPublicKey &&
      source.fields.every((field) =>
        validValue(field, credential.claims.fields[field.id]),
      )
    );
  } catch {
    return false;
  }
}
const presentationMessage = (run: IndustryRun, credentialsCommitment: string) =>
  canonicalJson({
    challenge: run.challenge,
    verifier: run.industry.verifier,
    subject: run.industry.subject,
    credentialsCommitment,
  });
export const criteriaRequest = (
  run: IndustryRun,
  sourceId: string,
): CriteriaRequest => {
  const source = run.industry.sources.find((s) => s.id === sourceId)!;
  return {
    schema: source.schema,
    subject: run.industry.subject,
    holderPublicKey: run.holderPublicKey,
    issuerPublicKey: deriveSignerPublicKey(sourceKey(run.industry, sourceId)),
    challenge: `${run.challenge}:${sourceId}`,
    criteria: run.industry.rules
      .filter((r) => r.source === sourceId)
      .map((r) => ({
        ...r,
        kind: source.fields.find((f) => f.id === r.field)!.type,
      })),
  };
};
const advanceIndustry = async (
  run: IndustryRun,
  artifacts?: string,
): Promise<IndustryRun> => {
  const next = (patch: Partial<IndustryRun>): IndustryRun => ({
    ...run,
    ...patch,
    completed: run.completed + 1,
  });
  switch (run.completed) {
    case 0: {
      const digest = await commitValue(contractDocument(run.industry));
      return next({
        raw: structuredClone(run.inputs),
        challenge: `${run.challenge}:contract:${digest}`,
      });
    }
    case 1: {
      const prepared = run.industry.sources.map((source) => {
        const raw = run.raw[source.id];
        if (!raw?.subject.trim())
          throw new IndustryError(`${source.name}: a subject is required.`);
        const fields = Object.fromEntries(
          source.fields.map((field) => {
            const value = raw.fields[field.id];
            if (!validValue(field, value))
              throw new IndustryError(
                `${source.name}: ${field.label} needs a valid ${field.type}.`,
              );
            return [field.id, typeof value === "string" ? value.trim() : value];
          }),
        );
        if (
          source.id === "sensor" &&
          Number(fields.minimum) > Number(fields.maximum)
        )
          throw new IndustryError(
            "Minimum temperature cannot exceed maximum temperature.",
          );
        return {
          id: `${run.id}:${source.id}`,
          issuer: source.id,
          schema: source.schema,
          subject: raw.subject.trim(),
          holderPublicKey: run.holderPublicKey,
          fields,
        };
      });
      return next({ prepared });
    }
    case 2:
      return next({
        privatePods: run.prepared.map((claims) =>
          issueCriteriaPod(
            { ...criteriaRequest(run, claims.issuer), subject: claims.subject },
            claims.fields,
            sourceKey(run.industry, claims.issuer),
          ).toJSON(),
        ),
        issued: run.prepared.map((claims) => ({
          claims,
          pod: POD.sign(
            { credential: { type: "string", value: canonicalJson(claims) } },
            sourceKey(run.industry, claims.issuer),
          ).toJSON(),
        })),
      });
    case 3:
      return next({ wallet: structuredClone(run.issued) });
    case 4: {
      if (run.privateMode) {
        const invalid = run.industry.rules.find((rule) => {
          const c = run.wallet.find((c) => c.claims.issuer === rule.source);
          const v = c?.claims.fields[rule.field];
          return (
            !c ||
            !authenticateIndustryCredential(
              c,
              run.industry,
              run.industry.sources.find((s) => s.id === rule.source)!,
              run,
            ) ||
            !(rule.operator === "eq"
              ? v === rule.value
              : rule.operator === "gte"
                ? v! >= rule.value
                : v! <= rule.value)
          );
        });
        if (invalid)
          throw new IndustryError(
            `Private preflight failed: ${invalid.label}. No proof or private values were sent. Correct the source input to continue.`,
          );
        const proofs: GpcProofEnvelope[] = [];
        for (const [index, source] of run.industry.sources.entries())
          proofs.push(
            await proveCriteria(
              POD.fromJSON(run.privatePods[index]!),
              criteriaRequest(run, source.id),
              artifacts,
            ),
          );
        const signature = POD.sign(
          {
            presentation: {
              type: "string",
              value: presentationMessage(run, await commitValue(proofs)),
            },
          },
          run.holderSecret,
        ).toJSON();
        return next({ privateInbox: { proofs, signature } });
      }
      const credentials = structuredClone(run.wallet);
      const message = presentationMessage(run, await commitValue(credentials));
      return next({
        inbox: {
          credentials,
          presentation: POD.sign(
            { presentation: { type: "string", value: message } },
            run.holderSecret,
          ).toJSON(),
        },
      });
    }
    case 5: {
      if (run.privateMode) {
        if (!run.privateInbox)
          throw new IndustryError("No private proof presentation received");
        const { proofs, signature } = run.privateInbox;
        const signer = POD.fromJSON(signature);
        const checks: IndustryCheck[] = [
          {
            label: "Contract digest matches current agreement",
            satisfied: run.challenge.endsWith(
              `:contract:${await commitValue(contractDocument(run.industry))}`,
            ),
            detail: "The complete agreement is bound to this request.",
          },
          {
            label: "Holder signature, proof set and request challenge",
            satisfied:
              signer.verifySignature() &&
              signer.signerPublicKey === run.holderPublicKey &&
              signer.content.getValue("presentation")?.value ===
                presentationMessage(run, await commitValue(proofs)) &&
              proofs.length === run.industry.sources.length,
            detail: "No source claims disclosed",
          },
        ];
        for (const [index, source] of run.industry.sources.entries()) {
          const valid =
            !!proofs[index] &&
            (await verifyCriteria(
              proofs[index]!,
              criteriaRequest(run, source.id),
              artifacts,
            ));
          for (const rule of run.industry.rules.filter(
            (r) => r.source === source.id,
          ))
            checks.push({
              label: rule.label,
              satisfied: valid,
              detail:
                "Verified by source-specific zero-knowledge proof; exact value hidden",
            });
        }
        const receipt = {
          policyCommitment: await commitValue(
            run.industry.sources.map((s) => criteriaRequest(run, s.id)),
          ),
          proofCommitment: await commitValue(run.privateInbox),
          evidenceRoot: await commitValue(proofs.map((p) => p.proofCommitment)),
          subjectNullifier: await commitValue({
            holder: run.holderPublicKey,
            challenge: run.challenge,
          }),
          satisfied: checks.every((c) => c.satisfied),
        };
        return next({ checks, receipt });
      }
      if (!run.inbox) throw new IndustryError("No presentation received");
      const { credentials, presentation } = run.inbox;
      let holderValid = false;
      try {
        const pod = POD.fromJSON(presentation);
        holderValid =
          pod.verifySignature() &&
          pod.signerPublicKey === run.holderPublicKey &&
          pod.content.getValue("presentation")?.value ===
            presentationMessage(run, await commitValue(credentials));
      } catch {
        /* Corrupt presentations fail closed. */
      }
      const checks: IndustryCheck[] = [
        {
          label: "Contract digest matches current agreement",
          satisfied: run.challenge.endsWith(
            `:contract:${await commitValue(contractDocument(run.industry))}`,
          ),
          detail: "The complete agreement is bound to this request.",
        },
        {
          label: "Holder signature and fresh challenge",
          satisfied: holderValid,
          detail:
            "Matches the verifier, requested subject and exact credential set.",
        },
        {
          label: "Exactly one credential from each required issuer",
          satisfied:
            credentials.length === run.industry.sources.length &&
            new Set(credentials.map((c) => c.claims.issuer)).size ===
              run.industry.sources.length,
          detail: "Duplicate credentials cannot replace a missing institution.",
        },
      ];
      for (const source of run.industry.sources) {
        const record = credentials.find((c) => c.claims.issuer === source.id);
        const authenticated =
          !!record &&
          authenticateIndustryCredential(record, run.industry, source, run);
        checks.push({
          label: `${source.name}: authentic and correctly bound`,
          satisfied: authenticated,
          detail: "Expected signer, schema, subject, holder and typed claims.",
        });
        for (const rule of run.industry.rules.filter(
          (rule) => rule.source === source.id,
        )) {
          const value = record?.claims.fields[rule.field];
          const matches =
            typeof value === typeof rule.value &&
            (rule.operator === "eq"
              ? value === rule.value
              : rule.operator === "gte"
                ? value! >= rule.value
                : value! <= rule.value);
          checks.push({
            label: rule.label,
            satisfied: authenticated && matches,
            detail: `${String(value ?? "missing")} ${rule.operator === "eq" ? "=" : rule.operator === "gte" ? "≥" : "≤"} ${String(rule.value)}`,
          });
        }
      }
      const receipt = {
        policyCommitment: await commitValue({
          subject: run.industry.subject,
          rules: run.industry.rules,
          verifier: run.industry.verifier,
          challenge: run.challenge,
        }),
        proofCommitment: await commitValue(run.inbox),
        evidenceRoot: await commitValue(credentials),
        subjectNullifier: await commitValue({
          holder: run.holderPublicKey,
          challenge: run.challenge,
        }),
        satisfied: checks.every((check) => check.satisfied),
      };
      return next({ checks, receipt });
    }
    case 6: {
      if (!run.receipt)
        throw new IndustryError("Verify before simulating a receipt");
      return next({
        ledger: [
          { type: "VerificationRecorded (simulation)", receipt: run.receipt },
        ],
      });
    }
    default:
      throw new IndustryError("Run complete. Reset to enter new data.");
  }
};
export const advanceIndustryRun = (run: IndustryRun, artifacts?: string) =>
  Effect.tryPromise({
    try: () => advanceIndustry(run, artifacts),
    catch: (cause) =>
      cause instanceof IndustryError
        ? cause
        : new IndustryError(
            cause instanceof Error ? cause.message : String(cause),
          ),
  });
