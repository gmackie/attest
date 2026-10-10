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
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const connectedRequestSchema = z
  .object({
    kind: z.literal("ConnectedTrainingRequest"),
    version: z.literal(1),
    id: z.string().uuid(),
    chainId: z.literal(11155111),
    registry: address,
    audience: address,
    issuerAccount: address,
    credentialId: z.string().uuid(),
    contentID: z.string().regex(/^\d+$/),
    subject: z.string().min(1).max(200),
    holderPublicKey: z.string().min(20),
    issuerPublicKey: z.string().min(20),
    minimumHours: z.number().int().min(1).max(10000),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ConnectedRequest = z.infer<typeof connectedRequestSchema>;
export const trainingSchema = "attest.connected.training.v1";
export const connectedCredentialSchema = z
  .object({
    kind: z.literal("ConnectedTrainingCredential"),
    version: z.literal(1),
    id: z.string().uuid(),
    chainId: z.literal(11155111),
    registry: address,
    issuerAccount: address,
    subject: z.string().min(1).max(200),
    holderPublicKey: z.string().min(20),
    issuerPublicKey: z.string().min(20),
    contentID: z.string().regex(/^\d+$/),
    validThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    pod: z.custom<ReturnType<POD["toJSON"]>>((value) => {
      try {
        return POD.fromJSON(
          value as ReturnType<POD["toJSON"]>,
        ).verifySignature();
      } catch {
        return false;
      }
    }),
  })
  .strict()
  .refine((c) => {
    try {
      const pod = POD.fromJSON(c.pod),
        entries = pod.content.asEntries();
      return (
        pod.contentID.toString() === c.contentID &&
        pod.signerPublicKey === c.issuerPublicKey &&
        entries.schema?.value === trainingSchema &&
        entries.subject?.value === c.subject &&
        entries.holder?.value === c.holderPublicKey &&
        entries.claim_credentialId?.value === c.id &&
        entries.claim_validThrough?.value ===
          criterionValue(c.validThrough, "date").value
      );
    } catch {
      return false;
    }
  }, "Credential metadata does not match its signed contents");
export type ConnectedCredential = z.infer<typeof connectedCredentialSchema>;
export type ConnectedPresentation = {
  kind: "ConnectedTrainingPresentation";
  requestDigest: string;
  proof: GpcProofEnvelope;
  signature: ReturnType<POD["toJSON"]>;
};
export const signingPublicKey = (privateKey: string) =>
  deriveSignerPublicKey(privateKey);
async function proofRequest(
  request: ConnectedRequest,
): Promise<CriteriaRequest> {
  return {
    contentID: request.contentID,
    schema: trainingSchema,
    subject: request.subject,
    holderPublicKey: request.holderPublicKey,
    issuerPublicKey: request.issuerPublicKey,
    challenge: await commitValue(request),
    criteria: [
      {
        field: "credentialId",
        operator: "eq",
        value: request.credentialId,
        kind: "text",
      },
      {
        field: "hours",
        operator: "gte",
        value: request.minimumHours,
        kind: "number",
      },
      {
        field: "validThrough",
        operator: "gte",
        value: request.expiresAt.slice(0, 10),
        kind: "date",
      },
    ],
  };
}
export async function issueConnectedCredential(
  input: Omit<
    ConnectedCredential,
    "kind" | "version" | "pod" | "issuerPublicKey" | "contentID"
  >,
  hours: number,
  privateKey: string,
): Promise<ConnectedCredential> {
  if (!Number.isInteger(hours) || hours < 0 || hours > 10000)
    throw new Error("Training hours must be an integer from 0 to 10000");
  const issuerPublicKey = signingPublicKey(privateKey);
  const request = connectedRequestSchema.parse({
    kind: "ConnectedTrainingRequest",
    version: 1,
    id: crypto.randomUUID(),
    chainId: input.chainId,
    registry: input.registry,
    audience: input.issuerAccount,
    issuerAccount: input.issuerAccount,
    credentialId: input.id,
    contentID: "0",
    subject: input.subject,
    holderPublicKey: input.holderPublicKey,
    issuerPublicKey,
    minimumHours: 1,
    expiresAt: new Date().toISOString(),
  });
  const req = await proofRequest(request);
  const pod = issueCriteriaPod(
    req,
    { credentialId: input.id, hours, validThrough: input.validThrough },
    privateKey,
  );
  return connectedCredentialSchema.parse({
    ...input,
    kind: "ConnectedTrainingCredential",
    version: 1,
    issuerPublicKey,
    contentID: pod.contentID.toString(),
    pod: pod.toJSON(),
  });
}
export function credentialManifest(c: ConnectedCredential) {
  const { pod: _, validThrough: __, ...metadata } = c;
  return metadata;
}
export async function prepareConnectedPresentation(
  credential: ConnectedCredential,
  input: ConnectedRequest,
  privateKey: string,
  artifacts?: string,
): Promise<ConnectedPresentation> {
  const request = connectedRequestSchema.parse(input),
    c = connectedCredentialSchema.parse(credential);
  if (Date.parse(request.expiresAt) <= Date.now())
    throw new Error("Request expired");
  if (
    request.contentID !== c.contentID ||
    request.credentialId !== c.id ||
    request.chainId !== c.chainId ||
    request.registry.toLowerCase() !== c.registry.toLowerCase() ||
    request.issuerAccount.toLowerCase() !== c.issuerAccount.toLowerCase() ||
    request.subject !== c.subject ||
    request.issuerPublicKey !== c.issuerPublicKey ||
    request.holderPublicKey !== c.holderPublicKey ||
    signingPublicKey(privateKey) !== c.holderPublicKey
  )
    throw new Error(
      "Credential, holder, issuer, network or registry binding mismatch",
    );
  const proof = await proveCriteria(
    POD.fromJSON(c.pod),
    await proofRequest(request),
    artifacts,
  );
  const value = {
    kind: "ConnectedTrainingPresentation" as const,
    requestDigest: await commitValue(request),
    proof,
  };
  return {
    ...value,
    signature: POD.sign(
      { presentation: { type: "string", value: canonicalJson(value) } },
      privateKey,
    ).toJSON(),
  };
}
export async function verifyConnectedPresentation(
  p: ConnectedPresentation,
  input: ConnectedRequest,
  audience: string,
  artifacts?: string,
) {
  try {
    const request = connectedRequestSchema.parse(input);
    if (
      Date.parse(request.expiresAt) <= Date.now() ||
      request.audience.toLowerCase() !== audience.toLowerCase() ||
      p.kind !== "ConnectedTrainingPresentation" ||
      p.requestDigest !== (await commitValue(request))
    )
      return false;
    const { signature, ...value } = p,
      pod = POD.fromJSON(signature);
    if (
      !pod.verifySignature() ||
      pod.signerPublicKey !== request.holderPublicKey ||
      pod.content.asEntries().presentation?.value !== canonicalJson(value)
    )
      return false;
    return verifyCriteria(p.proof, await proofRequest(request), artifacts);
  } catch {
    return false;
  }
}
export const connectedVaultSchema = z
  .object({
    version: z.literal(1),
    privateKey: z.string().regex(/^[0-9a-f]{64}$/),
    credentials: z.array(connectedCredentialSchema).max(100),
    requests: z.array(connectedRequestSchema).max(100),
    presentations: z
      .array(
        z
          .object({
            request: connectedRequestSchema,
            presentation: z.custom<ConnectedPresentation>(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ConnectedVault = z.infer<typeof connectedVaultSchema>;
