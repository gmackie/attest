import { z } from "zod";
import { POD, deriveSignerPublicKey } from "@pcd/pod";
import { canonicalJson, commitValue } from "@attest/core";
import {
  issueCriteriaPod,
  proveCriteria,
  verifyCriteria,
  criterionValue,
  type CriteriaRequest,
  type GpcProofEnvelope,
} from "@attest/proofs";
import type { JourneyChainRecord } from "@attest/chain-evm";
export const fictionalInstitutions = [
  {
    id: 0,
    name: "Cedar Skills Academy",
    initials: "CS",
    title: "Safety qualification",
    field: "trainingHours",
    unit: "hours",
    value: 40,
    minimum: 24,
    maximum: 200,
    verb: "Complete training",
    description:
      "Complete a fictional safety course. The academy signs your training hours and credential validity.",
    source: "Synthetic course attendance and assessment record",
    document: "Training certificate",
    color: "#47775f",
  },
  {
    id: 1,
    name: "Atlas Field Services",
    initials: "AF",
    title: "Verified experience",
    field: "experienceMonths",
    unit: "months",
    value: 36,
    minimum: 24,
    maximum: 120,
    verb: "Confirm experience",
    description:
      "Ask your fictional employer to confirm your work history. Exact months stay in your credential.",
    source: "Synthetic employment history and supervisor review",
    document: "Experience statement",
    color: "#62639c",
  },
  {
    id: 2,
    name: "Harbor Mutual",
    initials: "HM",
    title: "Liability assurance",
    field: "coverageUsd",
    unit: "USD coverage",
    value: 2000000,
    minimum: 1000000,
    maximum: 10000000,
    verb: "Issue assurance",
    description:
      "Obtain a fictional liability coverage assurance. The insurer signs the amount; the client only needs a minimum.",
    source: "Synthetic policy schedule and underwriting approval",
    document: "Coverage assurance",
    color: "#9a713e",
  },
] as const;
export const journeyProfile = "attest.institutional.contractor.v2";
export { default as institutionDirectory } from "./config/institutions.json";
import directory from "./config/institutions.json";
export const institutionSigningKeys = directory.institutions
  .slice(0, 3)
  .map((i) => i.credentialPublicKey);
export const fictionalAudience = "demo:northstar-project-817";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
const institutionId = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const signature = z.custom<ReturnType<POD["toJSON"]>>((v) => {
  try {
    return POD.fromJSON(v as ReturnType<POD["toJSON"]>).verifySignature();
  } catch {
    return false;
  }
});
export const journeyCredentialSchema = z
  .object({
    institution: institutionId,
    value: z.number().int().nonnegative(),
    validThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    contentID: z.string().regex(/^\d+$/),
    pod: signature,
  })
  .strict();
export type JourneyCredential = z.infer<typeof journeyCredentialSchema>;
export const journeyVaultSchema = z
  .object({
    version: z.literal(1),
    profile: z.literal(journeyProfile),
    chainId: z.literal(11155111),
    registry: address,
    account: address,
    id: z.string().uuid(),
    privateKey: z.string().regex(/^[0-9a-f]{64}$/),
    issuerPublicKeys: z.array(z.string()).length(3),
    credentials: z.array(journeyCredentialSchema).max(3),
    plans: z
      .array(
        z.object({
          institution: z.union([z.literal(0), z.literal(1), z.literal(2)]),
          value: z.number().int().nonnegative(),
          validThrough: z.string(),
        }),
      )
      .max(3)
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set<number>();
    for (const c of v.credentials) {
      try {
        const p = POD.fromJSON(c.pod),
          e = p.content.asEntries(),
          institution = fictionalInstitutions[c.institution];
        if (
          ids.has(c.institution) ||
          c.value > institution.maximum ||
          p.contentID.toString() !== c.contentID ||
          p.signerPublicKey !== v.issuerPublicKeys[c.institution] ||
          e.schema?.value !== `${journeyProfile}.${c.institution}` ||
          e.subject?.value !==
            `${v.chainId}:${v.registry}:${v.account}:${v.id}` ||
          e.holder?.value !== deriveSignerPublicKey(v.privateKey) ||
          e.claim_value?.value !== criterionValue(c.value, "number").value ||
          e.claim_validThrough?.value !==
            criterionValue(c.validThrough, "date").value
        )
          throw Error("Invalid binding");
        ids.add(c.institution);
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            "Credential contents, issuer, holder or journey binding is invalid",
        });
      }
    }
  });
export type JourneyVault = z.infer<typeof journeyVaultSchema>;
export function createJourneyVault(
  account: string,
  registry: string,
  issuerPublicKeys: string[] = institutionSigningKeys,
): JourneyVault {
  return journeyVaultSchema.parse({
    version: 1,
    profile: journeyProfile,
    issuerPublicKeys,
    chainId: 11155111,
    account,
    registry,
    id: crypto.randomUUID(),
    privateKey: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
    credentials: [],
  });
}
export const journeyRequestSchema = z
  .object({
    version: z.literal(1),
    profile: z.literal(journeyProfile),
    chainId: z.literal(11155111),
    registry: address,
    account: address,
    journey: z.string().uuid(),
    holderPublicKey: z.string(),
    issuerPublicKeys: z.array(z.string()).length(3),
    id: z.string().uuid(),
    audience: z.literal(fictionalAudience),
    expiresAt: z.string().datetime(),
    contentIDs: z.array(z.string().regex(/^\d+$/)).length(3),
  })
  .strict();
export type JourneyRequest = z.infer<typeof journeyRequestSchema>;
export type JourneyPresentation = {
  requestDigest: string;
  proofs: GpcProofEnvelope[];
  signature: ReturnType<POD["toJSON"]>;
};
function criteria(request: JourneyRequest, id: number): CriteriaRequest {
  const i = fictionalInstitutions[id]!;
  return {
    schema: `${journeyProfile}.${id}`,
    subject: `11155111:${request.registry}:${request.account}:${request.journey}`,
    holderPublicKey: request.holderPublicKey,
    issuerPublicKey: request.issuerPublicKeys[id]!,
    challenge: "",
    contentID: request.contentIDs[id]!,
    criteria: [
      { field: "value", operator: "gte", value: i.minimum, kind: "number" },
      {
        field: "validThrough",
        operator: "gte",
        value: request.expiresAt.slice(0, 10),
        kind: "date",
      },
    ],
  };
}
export function issueInstitutionCredential(
  input: {
    account: string;
    registry: string;
    id: string;
    holderPublicKey: string;
    issuerPublicKeys: string[];
  },
  id: 0 | 1 | 2,
  value: number,
  issuerPrivateKey: string,
  salt: string,
  validThrough: string,
): JourneyCredential {
  const v = input,
    i = fictionalInstitutions[id];
  if (!Number.isSafeInteger(value) || value < 0 || value > i.maximum)
    throw new Error(`Choose a whole number from 0 to ${i.maximum}`);
  if (deriveSignerPublicKey(issuerPrivateKey) !== v.issuerPublicKeys[id])
    throw new Error("Issuer key mismatch");
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error("Invalid private salt");
  const request: JourneyRequest = {
    version: 1,
    profile: journeyProfile,
    chainId: 11155111,
    registry: v.registry,
    account: v.account,
    journey: v.id,
    holderPublicKey: v.holderPublicKey,
    issuerPublicKeys: v.issuerPublicKeys,
    id: crypto.randomUUID(),
    audience: fictionalAudience,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    contentIDs: ["0", "0", "0"],
  };
  const sourcePod = issueCriteriaPod(
    criteria(request, id),
    { value, validThrough },
    issuerPrivateKey,
  );
  const pod = POD.sign(
    {
      ...sourcePod.content.asEntries(),
      privateSalt: { type: "string", value: salt },
    },
    issuerPrivateKey,
  );
  return {
    institution: id,
    value,
    validThrough,
    contentID: pod.contentID.toString(),
    pod: pod.toJSON(),
  };
}
export function requestJourney(v: JourneyVault): JourneyRequest {
  const vault = journeyVaultSchema.parse(v);
  if (vault.credentials.length !== 3)
    throw new Error("Collect all three institutional credentials first");
  return journeyRequestSchema.parse({
    version: 1,
    profile: journeyProfile,
    chainId: 11155111,
    registry: vault.registry,
    account: vault.account,
    journey: vault.id,
    holderPublicKey: deriveSignerPublicKey(vault.privateKey),
    issuerPublicKeys: vault.issuerPublicKeys,
    id: crypto.randomUUID(),
    audience: fictionalAudience,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    contentIDs: fictionalInstitutions.map(
      (i) => vault.credentials.find((c) => c.institution === i.id)!.contentID,
    ),
  });
}
export async function prepareJourney(
  v: JourneyVault,
  input: JourneyRequest,
  artifacts?: string,
  onProgress?: (completed: number) => void,
): Promise<JourneyPresentation> {
  const vault = journeyVaultSchema.parse(v),
    request = journeyRequestSchema.parse(input);
  if (
    canonicalJson(request.issuerPublicKeys) !==
      canonicalJson(vault.issuerPublicKeys) ||
    request.account !== vault.account ||
    request.registry !== vault.registry ||
    request.journey !== vault.id ||
    request.holderPublicKey !== deriveSignerPublicKey(vault.privateKey) ||
    Date.parse(request.expiresAt) <= Date.now()
  )
    throw new Error(
      "Request does not match this wallet, registry or journey, or has expired",
    );
  const digest = await commitValue(request),
    proofs: GpcProofEnvelope[] = [];
  for (const i of fictionalInstitutions) {
    const c = vault.credentials.find((c) => c.institution === i.id);
    if (!c || c.contentID !== request.contentIDs[i.id])
      throw new Error("Request content differs from credential");
    if (c.value < i.minimum || c.validThrough < request.expiresAt.slice(0, 10))
      throw new Error(
        `${i.name}: ${i.title.toLowerCase()} does not meet Northstar’s requirements. No approval proof can be generated.`,
      );
  }
  for (const i of fictionalInstitutions) {
    const c = vault.credentials.find((c) => c.institution === i.id)!;
    proofs.push(
      await proveCriteria(
        POD.fromJSON(c.pod),
        { ...criteria(request, i.id), challenge: digest },
        artifacts,
      ),
    );
    onProgress?.(proofs.length);
  }
  const value = { requestDigest: digest, proofs };
  return {
    ...value,
    signature: POD.sign(
      { presentation: { type: "string", value: canonicalJson(value) } },
      vault.privateKey,
    ).toJSON(),
  };
}
export async function verifyJourney(
  p: JourneyPresentation,
  input: JourneyRequest,
  records: JourneyChainRecord[],
  blockTimestamp: bigint,
  artifacts?: string,
): Promise<{ name: string; pass: boolean; detail: string }[]> {
  const request = journeyRequestSchema.parse(input),
    digest = await commitValue(request);
  let holder = false;
  try {
    const signed = POD.fromJSON(p.signature),
      { signature: _, ...value } = p;
    holder =
      signed.verifySignature() &&
      signed.signerPublicKey === request.holderPublicKey &&
      signed.content.asEntries().presentation?.value === canonicalJson(value) &&
      p.requestDigest === digest &&
      p.proofs.length === 3 &&
      Date.parse(request.expiresAt) > Date.now();
  } catch {}
  const checks = [
    {
      name: "Holder & request",
      pass: holder,
      detail:
        "Holder signature binds this exact request, recipient, journey and proof bundle; request has not expired.",
    },
  ];
  for (const i of fictionalInstitutions) {
    let proof = false;
    try {
      proof =
        holder &&
        (await verifyCriteria(
          p.proofs[i.id]!,
          { ...criteria(request, i.id), challenge: digest },
          artifacts,
        ));
    } catch {}
    const r = records[i.id],
      anchored =
        !!r &&
        r.content === (await commitValue(request.contentIDs[i.id])) &&
        r.holderKey === (await commitValue(request.holderPublicKey)),
      current =
        !!r &&
        !r.revoked &&
        r.validUntil > blockTimestamp &&
        r.validUntil >=
          BigInt(Math.floor(Date.parse(request.expiresAt) / 1000));
    checks.push({
      name: i.title,
      pass: proof && anchored && current,
      detail: !proof
        ? "Private proof or signed context failed"
        : !anchored
          ? "No matching content and holder commitment in this wallet’s registry record"
          : !current
            ? "Registry record expired or revoked"
            : `${i.name}: threshold proven; exact signed content anchored; status current.`,
    });
  }
  return checks;
}
export const journeyNamespace = (account: string, registry: string) =>
  `attest:journey:v2:11155111:${registry.toLowerCase()}:${account.toLowerCase()}`;
export const journeyHolderKey = (v: JourneyVault) =>
  deriveSignerPublicKey(v.privateKey);
