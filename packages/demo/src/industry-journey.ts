import { z } from "zod";
import { POD, deriveSignerPublicKey } from "@pcd/pod";
import { canonicalJson, commitValue } from "@attest/core";
import {
  criterionValue,
  issueCriteriaPod,
  proveCriteria,
  verifyCriteria,
  type CriteriaRequest,
  type GpcProofEnvelope,
} from "@attest/proofs";
import { industries, type FieldValue } from "./industries";
import {
  withContract,
  contractDocument,
  type ContractLevel,
} from "./contracts";
import directory from "./config/industry-wallets.json";
export const industryIds = ["healthcare", "education", "logistics"] as const;
export type ConnectedIndustry = (typeof industryIds)[number];
export const industryWallets = directory.profiles;
export const industryProfile = (id: ConnectedIndustry) =>
  `attest.industry.${id}.v1`;
export const industryDefinition = (
  id: ConnectedIndustry,
  level: ContractLevel = "standard",
) =>
  withContract(
    industries.find((i) => i.id === id)!,
    level,
  );
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
const fields = z.record(
  z.string().max(64),
  z.union([z.string().max(200), z.number().finite(), z.boolean()]),
);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
  );
const contextSchema = z.object({
  industry: z.enum(industryIds),
  account: address,
  registry: address,
  journey: z.string().uuid(),
  holderPublicKey: z.string().min(20).max(100),
});
export const industryCommandSchema = contextSchema
  .extend({
    version: z.literal(1),
    chainId: z.literal(11155111),
    domain: z.literal("attest.gmac.io"),
    action: z.enum(["issue", "revoke"]),
    institution: z.number().int().min(0).max(4),
    fields,
    validThrough: date,
    expiresAt: z.string().datetime(),
    nonce: z.string().uuid(),
    demoConsent: z.literal(true),
  })
  .strict();
export type IndustryCommand = z.infer<typeof industryCommandSchema>;
export const industryCommandMessage = (c: IndustryCommand) =>
  `Attest Sepolia fictional ${c.industry} request\n${industryWallets[c.industry][c.institution]!.name}\n${c.action === "issue" ? "Issue synthetic evidence and sponsor registration" : "Permanently revoke this synthetic credential"}\nNo transfer of your funds. Fictional claims only.\n${canonicalJson(c)}`;
export type ConnectedIndustryCredential = {
  institution: number;
  fields: Record<string, FieldValue>;
  validThrough: string;
  contentID: string;
  pod: ReturnType<POD["toJSON"]>;
};
export type IndustryVault = z.infer<typeof contextSchema> & {
  version: 1;
  privateKey: string;
  credentials: ConnectedIndustryCredential[];
  plans: {
    institution: number;
    fields: Record<string, FieldValue>;
    validThrough: string;
  }[];
};
export const industryHolderKey = (v: IndustryVault) =>
  deriveSignerPublicKey(v.privateKey);
export const industryNamespace = (
  id: ConnectedIndustry,
  account: string,
  registry: string,
) =>
  `${industryProfile(id)}:11155111:${account.toLowerCase()}:${registry.toLowerCase()}`;
export function newIndustryVault(
  industry: ConnectedIndustry,
  account: string,
  registry: string,
): IndustryVault {
  const privateKey = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  return {
    ...contextSchema.parse({
      industry,
      account,
      registry,
      journey: crypto.randomUUID(),
      holderPublicKey: deriveSignerPublicKey(privateKey),
    }),
    version: 1,
    privateKey,
    credentials: [],
    plans: [],
  };
}
export function validateIndustryFields(
  industry: ConnectedIndustry,
  institution: number,
  input: Record<string, FieldValue>,
) {
  const source = industryDefinition(industry).sources[institution];
  if (!source) throw new Error("Unknown institution");
  if (Object.keys(input).length !== source.fields.length)
    throw new Error("Supply exactly the fields for this institution");
  for (const f of source.fields) {
    const v = input[f.id];
    criterionValue(v!, f.type);
    if (typeof v === "string" && v.length > 200)
      throw new Error("Synthetic text too long");
    if (typeof v === "number" && Math.abs(v) > 100000000)
      throw new Error("Synthetic value outside demo range");
  }
  if(industry==='logistics'&&source.id==='sensor'&&Number(input.minimum)>Number(input.maximum))throw new Error('Minimum temperature cannot exceed maximum');
  return input;
}
const subject = (c: z.infer<typeof contextSchema>) =>
  `11155111:${c.registry}:${c.account}:${c.journey}:${c.industry}`;
function sourceRequest(
  c: z.infer<typeof contextSchema>,
  institution: number,
  level: ContractLevel,
  expiresAt: string,
  contentID?: string,
): CriteriaRequest {
  const definition = industryDefinition(c.industry, level),
    source = definition.sources[institution]!;
  return {
    schema: `${industryProfile(c.industry)}:${source.schema}`,
    subject: subject(c),
    holderPublicKey: c.holderPublicKey,
    issuerPublicKey:
      industryWallets[c.industry][institution]!.credentialPublicKey,
    challenge: "",
    ...(contentID ? { contentID } : {}),
    criteria: [
      ...definition.rules
        .filter((r) => r.source === source.id)
        .map((r) => ({
          field: r.field,
          operator: r.operator,
          // A historical agreement date never permits evidence expired for this request.
          value:
            source.fields.find((f) => f.id === r.field)!.type === "date" &&
            r.operator === "gte" &&
            String(r.value) < expiresAt.slice(0, 10)
              ? expiresAt.slice(0, 10)
              : r.value,
          kind: source.fields.find((f) => f.id === r.field)!.type,
        })),
      {
        field: "attestValidThrough",
        operator: "gte",
        value: expiresAt.slice(0, 10),
        kind: "date",
      },
    ],
  };
}
export function issueIndustryCredential(
  command: IndustryCommand,
  key: string,
  salt: string,
): ConnectedIndustryCredential {
  const c = industryCommandSchema.parse(command);
  validateIndustryFields(c.industry, c.institution, c.fields);
  if (
    deriveSignerPublicKey(key) !==
      industryWallets[c.industry][c.institution]!.credentialPublicKey ||
    !/^[a-f0-9]{64}$/.test(salt)
  )
    throw new Error("Issuer key or salt mismatch");
  const source = industryDefinition(c.industry).sources[c.institution]!;
  const template = sourceRequest(c, c.institution, "standard", c.expiresAt);
  // Sign every input field, including those not constrained by the selected contract.
  template.criteria = [
    ...source.fields.map((f) => ({
      field: f.id,
      kind: f.type,
      operator: "eq" as const,
      value: c.fields[f.id]!,
    })),
    {
      field: "attestValidThrough",
      kind: "date",
      operator: "gte",
      value: c.validThrough,
    },
  ];
  const unsigned = issueCriteriaPod(
    template,
    { ...c.fields, attestValidThrough: c.validThrough },
    key,
  );
  const pod = POD.sign(
    {
      ...unsigned.content.asEntries(),
      privateSalt: { type: "string", value: salt },
    },
    key,
  );
  return {
    institution: c.institution,
    fields: c.fields,
    validThrough: c.validThrough,
    contentID: pod.contentID.toString(),
    pod: pod.toJSON(),
  };
}
export function parseIndustryVault(input: unknown): IndustryVault {
  const parsed = contextSchema
    .extend({
      version: z.literal(1),
      privateKey: z.string().regex(/^[a-f0-9]{64}$/),
      credentials: z
        .array(
          z.object({
            institution: z.number().int().min(0).max(4),
            fields,
            validThrough: date,
            contentID: z.string().regex(/^\d+$/),
            pod: z.unknown(),
          }),
        )
        .max(5),
      plans: z
        .array(
          z.object({
            institution: z.number().int().min(0).max(4),
            fields,
            validThrough: date,
          }),
        )
        .max(5),
    })
    .strict()
    .parse(input);
  const v = parsed as IndustryVault;
  if (v.holderPublicKey !== industryHolderKey(v))
    throw new Error("Holder key mismatch");
  if (
    new Set(v.credentials.map((c) => c.institution)).size !==
      v.credentials.length ||
    new Set(v.plans.map((c) => c.institution)).size !== v.plans.length
  )
    throw new Error("Duplicate institution");
  for (const c of v.credentials) {
    validateIndustryFields(v.industry, c.institution, c.fields);
    const pod = POD.fromJSON(c.pod),
      e = pod.content.asEntries(),
      r = sourceRequest(v, c.institution, "standard", new Date().toISOString());
    if (
      !pod.verifySignature() ||
      pod.signerPublicKey !== r.issuerPublicKey ||
      pod.contentID.toString() !== c.contentID ||
      e.schema?.value !== r.schema ||
      e.subject?.value !== r.subject ||
      e.holder?.value !== v.holderPublicKey ||
      e.claim_attestValidThrough?.value !==
        criterionValue(c.validThrough, "date").value
    )
      throw new Error("Invalid credential binding");
    for (const f of industryDefinition(v.industry).sources[c.institution]!
      .fields)
      if (
        e[`claim_${f.id}`]?.value !==
        criterionValue(c.fields[f.id]!, f.type).value
      )
        throw new Error("Credential fields changed");
  }
  for (const p of v.plans)
    validateIndustryFields(v.industry, p.institution, p.fields);
  return v;
}
export const industryRequestSchema = contextSchema
  .extend({
    version: z.literal(1),
    chainId: z.literal(11155111),
    id: z.string().uuid(),
    level: z.enum(["standard", "enhanced", "critical"]),
    contractCommitment: z.string().regex(/^0x[a-f0-9]{64}$/),
    audience: z.string(),
    expiresAt: z.string().datetime(),
    contentIDs: z.array(z.string().regex(/^\d+$/)).length(5),
  })
  .strict();
export type IndustryRequest = z.infer<typeof industryRequestSchema>;
export type IndustryPresentation = {
  requestDigest: string;
  proofs: GpcProofEnvelope[];
  signature: ReturnType<POD["toJSON"]>;
};
export async function industryContractCommitment(
  industry: ConnectedIndustry,
  level: ContractLevel,
) {
  return commitValue({
    profile: industryProfile(industry),
    contract: contractDocument(industryDefinition(industry, level)),
    freshness: "All validity dates must also cover the request expiry date",
  });
}
export async function requestIndustry(
  v: IndustryVault,
  level: ContractLevel,
): Promise<IndustryRequest> {
  parseIndustryVault(v);
  if (v.credentials.length !== 5)
    throw new Error("Collect all five credentials");
  return industryRequestSchema.parse({
    version: 1,
    chainId: 11155111,
    industry: v.industry,
    account: v.account,
    registry: v.registry,
    journey: v.journey,
    holderPublicKey: v.holderPublicKey,
    id: crypto.randomUUID(),
    level,
    contractCommitment: await industryContractCommitment(v.industry, level),
    audience: industryDefinition(v.industry).verifier,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    contentIDs: [0, 1, 2, 3, 4].map(
      (i) => v.credentials.find((c) => c.institution === i)!.contentID,
    ),
  });
}
async function validateRequest(input: IndustryRequest) {
  const r = industryRequestSchema.parse(input);
  if (
    r.audience !== industryDefinition(r.industry).verifier ||
    r.contractCommitment !==
      (await industryContractCommitment(r.industry, r.level)) ||
    Date.parse(r.expiresAt) <= Date.now() ||
    Date.parse(r.expiresAt) > Date.now() + 3605000
  )
    throw new Error("Wrong contract, audience or request expiry");
  return r;
}
export async function prepareIndustry(
  v: IndustryVault,
  input: IndustryRequest,
  artifacts?: string,
  progress?: (n: number) => void,
): Promise<IndustryPresentation> {
  parseIndustryVault(v);
  const r = await validateRequest(input);
  for (const k of [
    "industry",
    "account",
    "registry",
    "journey",
    "holderPublicKey",
  ] as const)
    if (r[k] !== v[k]) throw new Error("Request belongs to another passport");
  const digest = await commitValue(r),
    proofs: GpcProofEnvelope[] = [];
  for (let i = 0; i < 5; i++) {
    const c = v.credentials.find((c) => c.institution === i);
    if (!c || c.contentID !== r.contentIDs[i])
      throw new Error("Credential missing or substituted");
    const req = {
      ...sourceRequest(r, i, r.level, r.expiresAt, c.contentID),
      challenge: digest,
    };
    for (const rule of req.criteria) {
      const actual = criterionValue(
          rule.field === "attestValidThrough"
            ? c.validThrough
            : c.fields[rule.field]!,
          rule.kind,
        ).value,
        expected = criterionValue(rule.value, rule.kind).value;
      if (
        actual === null ||
        expected === null ||
        !(rule.operator === "eq"
          ? actual === expected
          : rule.operator === "gte"
            ? actual >= expected
            : actual <= expected)
      )
        throw new Error(
          `${industryDefinition(v.industry).sources[i]!.name}: ${rule.field} does not satisfy ${rule.operator} ${rule.value}`,
        );
    }
    proofs.push(await proveCriteria(POD.fromJSON(c.pod), req, artifacts));
    progress?.(i + 1);
  }
  const value = { requestDigest: digest, proofs };
  return {
    ...value,
    signature: POD.sign(
      { presentation: { type: "string", value: canonicalJson(value) } },
      v.privateKey,
    ).toJSON(),
  };
}
export type IndustryRecord = {
  content: string;
  holderKey: string;
  validUntil: bigint;
  revoked: boolean;
};
export async function verifyIndustry(
  p: IndustryPresentation,
  input: IndustryRequest,
  records: IndustryRecord[],
  blockTime: bigint,
  artifacts?: string,
) {
  const r = await validateRequest(input),
    digest = await commitValue(r);
  let holder = false;
  try {
    const signed = POD.fromJSON(p.signature),
      { signature: _, ...value } = p;
    holder =
      signed.verifySignature() &&
      signed.signerPublicKey === r.holderPublicKey &&
      signed.content.asEntries().presentation?.value === canonicalJson(value) &&
      p.requestDigest === digest &&
      p.proofs.length === 5;
  } catch {}
  const checks = [
    {
      name: "Holder, contract & request",
      pass: holder,
      detail:
        "Signed request binds the profile, wallet, registry, agreement level and proof bundle.",
    },
  ];
  for (let i = 0; i < 5; i++) {
    const record = records[i],
      proof =
        holder &&
        (await verifyCriteria(
          p.proofs[i]!,
          {
            ...sourceRequest(r, i, r.level, r.expiresAt, r.contentIDs[i]),
            challenge: digest,
          },
          artifacts,
        )),
      anchored =
        record?.content === (await commitValue(r.contentIDs[i])) &&
        record?.holderKey === (await commitValue(r.holderPublicKey)),
      current =
        !!record &&
        !record.revoked &&
        record.validUntil > blockTime &&
        record.validUntil >= BigInt(Math.floor(Date.parse(r.expiresAt) / 1000));
    checks.push({
      name: industryDefinition(r.industry).sources[i]!.name,
      pass: !!(proof && anchored && current),
      detail: !proof
        ? "Private proof or issuer binding failed"
        : !anchored
          ? "Credential commitment does not match"
          : !current
            ? "Credential expired or revoked"
            : "All source clauses proven; exact credential and current status checked.",
    });
  }
  return checks;
}
