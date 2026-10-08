import type { AuthorityGraph } from "@attest/domain";

export type InstitutionRole =
  | "root"
  | "accreditor"
  | "insurer"
  | "auditor"
  | "certifier"
  | "supplier"
  | "buyer";
export type Institution = Readonly<{
  id: string;
  name: string;
  short: string;
  role: InstitutionRole;
  description: string;
}>;
export const institutions: readonly Institution[] = [
  {
    id: "root:insurance",
    name: "Insurance Trust Council",
    short: "ITC",
    role: "root",
    description: "The buyer's fictional trust anchor for insurance issuers.",
  },
  {
    id: "root:audit",
    name: "Audit Standards Board",
    short: "ASB",
    role: "root",
    description: "Accepts firms for SOC 2 examination assertions.",
  },
  {
    id: "root:quality",
    name: "Quality Accreditation Council",
    short: "QAC",
    role: "root",
    description:
      "Delegates certification authority through an accreditation body.",
  },
  {
    id: "accreditor:meridian",
    name: "Meridian Accreditation",
    short: "MA",
    role: "accreditor",
    description:
      "Delegated authority to authorize ISO 9001 certification bodies.",
  },
  {
    id: "insurer:harbor",
    name: "Harbor Mutual",
    short: "HM",
    role: "insurer",
    description: "Signs commercial general liability insurance credentials.",
  },
  {
    id: "insurer:summit",
    name: "Summit Assurance",
    short: "SA",
    role: "insurer",
    description:
      "An alternative trusted carrier with an independent signing key.",
  },
  {
    id: "auditor:cedar",
    name: "Cedar & Co. Audit",
    short: "CA",
    role: "auditor",
    description: "Issues signed SOC 2 Type II examination records.",
  },
  {
    id: "auditor:atlas",
    name: "Atlas Audit Partners",
    short: "AA",
    role: "auditor",
    description:
      "An independent audit firm in the accepted audit authority graph.",
  },
  {
    id: "certifier:verdant",
    name: "Verdant Certification",
    short: "VC",
    role: "certifier",
    description:
      "Certifies quality-management scope under Meridian's delegation.",
  },
  {
    id: "certifier:clearline",
    name: "Clearline Quality",
    short: "CQ",
    role: "certifier",
    description: "An alternative ISO 9001 certification body.",
  },
  {
    id: "supplier:acme",
    name: "Acme Industrial Controls",
    short: "AC",
    role: "supplier",
    description:
      "Established controls manufacturer. Holds $5M / $2M insurance.",
  },
  {
    id: "supplier:beacon",
    name: "Beacon Robotics",
    short: "BR",
    role: "supplier",
    description: "Robotics supplier. Holds $3M / $1M insurance.",
  },
  {
    id: "supplier:novus",
    name: "Novus Manufacturing",
    short: "NM",
    role: "supplier",
    description: "Large manufacturing supplier. Holds $10M / $5M insurance.",
  },
  {
    id: "buyer:northstar",
    name: "Northstar Infrastructure",
    short: "NI",
    role: "buyer",
    description: "Standard onboarding: $2M aggregate and $1M per occurrence.",
  },
  {
    id: "buyer:metro",
    name: "Metro Energy",
    short: "ME",
    role: "buyer",
    description:
      "Critical infrastructure: $5M aggregate and $2M per occurrence.",
  },
];
export const institution = (id: string): Institution => {
  const found = institutions.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown demo institution: ${id}`);
  return found;
};
export const byRole = (role: InstitutionRole) =>
  institutions.filter((entry) => entry.role === role);
export const supplierCoverage: Readonly<
  Record<string, readonly [number, number]>
> = {
  "supplier:acme": [5_000_000, 2_000_000],
  "supplier:beacon": [3_000_000, 1_000_000],
  "supplier:novus": [10_000_000, 5_000_000],
};
export const buyerThresholds: Readonly<
  Record<string, readonly [number, number]>
> = {
  "buyer:northstar": [2_000_000, 1_000_000],
  "buyer:metro": [5_000_000, 2_000_000],
};
// PUBLIC, deterministic demo keys. Never use these for real credentials.
export const demoPrivateKey = (issuerId: string): string => {
  const index = institutions.findIndex((entry) => entry.id === issuerId);
  if (
    index < 0 ||
    !["insurer", "auditor", "certifier"].includes(institutions[index]!.role)
  )
    throw new Error("Not a demo issuer");
  return (index + 100).toString(16).padStart(64, "0");
};
export const networkAuthority: AuthorityGraph = {
  acceptedRoots: byRole("root").map(({ id }) => id),
  grants: [
    ...byRole("insurer").map(({ id }) => ({
      id: `grant:${id}`,
      grantor: "root:insurance",
      grantee: id,
      actions: ["issue" as const],
      predicatePatterns: ["insurance.*"],
      schemas: ["attest:insurance:cgl:v1"],
      validUntil: "2030-01-01T00:00:00Z",
      mayDelegate: false,
    })),
    ...byRole("auditor").map(({ id }) => ({
      id: `grant:${id}`,
      grantor: "root:audit",
      grantee: id,
      actions: ["issue" as const],
      predicatePatterns: ["soc2.*"],
      schemas: ["attest:soc2:v1"],
      validUntil: "2030-01-01T00:00:00Z",
      mayDelegate: false,
    })),
    {
      id: "grant:meridian",
      grantor: "root:quality",
      grantee: "accreditor:meridian",
      actions: ["certify"],
      predicatePatterns: ["iso9001.*"],
      schemas: ["attest:iso9001:v1"],
      validUntil: "2030-01-01T00:00:00Z",
      mayDelegate: true,
      maxDelegationDepth: 1,
    },
    ...byRole("certifier").map(({ id }) => ({
      id: `grant:${id}`,
      grantor: "accreditor:meridian",
      grantee: id,
      actions: ["certify" as const],
      predicatePatterns: ["iso9001.*"],
      schemas: ["attest:iso9001:v1"],
      validUntil: "2030-01-01T00:00:00Z",
      mayDelegate: false,
    })),
  ],
};
