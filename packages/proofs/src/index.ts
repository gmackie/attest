import { canonicalJson, commitValue } from "@attest/core";
import {
  boundConfigFromJSON,
  boundConfigToJSON,
  gpcArtifactDownloadURL,
  gpcBindConfig,
  type GPCBoundConfig,
  type GPCProof,
  type GPCProofConfig,
  type GPCProofInputs,
  type JSONBoundConfig,
  type JSONRevealedClaims,
  gpcProve,
  gpcVerify,
  proofConfigToJSON,
  revealedClaimsFromJSON,
  revealedClaimsToJSON
} from "@pcd/gpc";
import { encodePublicKey, POD, POD_INT_MAX, type PODEntries } from "@pcd/pod";
import { Identity } from "@semaphore-protocol/core";
import { Effect } from "effect";

export const GPC_ARTIFACTS_URL = gpcArtifactDownloadURL("jsdelivr", "prod", undefined);

export class ProofError extends Error {
  readonly _tag = "ProofError";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export type InsurancePodInput = Readonly<{
  attestationId: string;
  subjectBinding: string;
  ownerPublicKey: string;
  aggregateUsd: bigint;
  perOccurrenceUsd: bigint;
  validUntilEpochSeconds: bigint;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
}>;

export type InsuranceRequirement = Readonly<{
  aggregateMinimumUsd: bigint;
  perOccurrenceMinimumUsd: bigint;
  validThroughEpochSeconds: bigint;
  requireAdditionalInsured: boolean;
  requireWaiverOfSubrogation: boolean;
  challenge: string;
  acceptedIssuerPublicKeys: readonly string[];
}>;

export type SerializedPod = ReturnType<POD["toJSON"]>;

export type GpcProofEnvelope = Readonly<{
  version: "attest-gpc-v1";
  proof: GPCProof;
  boundConfig: JSONBoundConfig;
  revealedClaims: JSONRevealedClaims;
  policyCommitment: string;
  proofCommitment: string;
  circuitIdentifier: GPCBoundConfig["circuitIdentifier"];
}>;

export const newHolderIdentity = (): Identity => new Identity();
export const restoreHolderIdentity = (serialized: string): Identity => Identity.import(serialized);
export const holderPublicKey = (identity: Identity): string => encodePublicKey(identity.publicKey);

export const issueInsurancePod = (input: InsurancePodInput, issuerPrivateKey: string): POD => {
  const entries = {
    pod_type: { type: "string", value: "attest.insurance.cgl.v1" },
    attestation_id: { type: "string", value: input.attestationId },
    subject_binding: { type: "string", value: input.subjectBinding },
    owner: { type: "eddsa_pubkey", value: input.ownerPublicKey },
    currency: { type: "string", value: "USD" },
    aggregate_usd: { type: "int", value: input.aggregateUsd },
    per_occurrence_usd: { type: "int", value: input.perOccurrenceUsd },
    valid_until: { type: "int", value: input.validUntilEpochSeconds },
    additional_insured: { type: "boolean", value: input.additionalInsured },
    waiver_of_subrogation: { type: "boolean", value: input.waiverOfSubrogation }
  } satisfies PODEntries;
  return POD.sign(entries, issuerPrivateKey);
};

export const serializePod = (pod: POD): SerializedPod => pod.toJSON();
export const deserializePod = (pod: SerializedPod): POD => POD.fromJSON(pod);

export const insuranceProofConfig = (requirement: InsuranceRequirement): GPCProofConfig => ({
  pods: {
    insurance: {
      entries: {
        pod_type: { isRevealed: false, isMemberOf: "acceptedSchemas" },
        owner: { isRevealed: false, isOwnerID: "SemaphoreV4" },
        aggregate_usd: {
          isRevealed: false,
          inRange: { min: requirement.aggregateMinimumUsd, max: POD_INT_MAX }
        },
        per_occurrence_usd: {
          isRevealed: false,
          inRange: { min: requirement.perOccurrenceMinimumUsd, max: POD_INT_MAX }
        },
        valid_until: {
          isRevealed: false,
          inRange: { min: requirement.validThroughEpochSeconds, max: POD_INT_MAX }
        },
        additional_insured: {
          isRevealed: false,
          ...(requirement.requireAdditionalInsured ? { isMemberOf: "requiredTrue" } : {})
        },
        waiver_of_subrogation: {
          isRevealed: false,
          ...(requirement.requireWaiverOfSubrogation ? { isMemberOf: "requiredTrue" } : {})
        }
      },
      signerPublicKey: { isRevealed: false, isMemberOf: "acceptedIssuers" }
    }
  }
});

const proofInputs = (
  pod: POD,
  identity: Identity,
  requirement: InsuranceRequirement
): GPCProofInputs => ({
  pods: { insurance: pod },
  owner: {
    semaphoreV4: identity,
    externalNullifier: { type: "string", value: `attest:${requirement.challenge}` }
  },
  membershipLists: {
    acceptedSchemas: [{ type: "string", value: "attest.insurance.cgl.v1" }],
    acceptedIssuers: requirement.acceptedIssuerPublicKeys.map((value) => ({ type: "eddsa_pubkey" as const, value })),
    requiredTrue: [{ type: "boolean", value: true }]
  },
  watermark: { type: "string", value: requirement.challenge }
});

export const proveInsuranceRequirement = async (
  pod: POD,
  identity: Identity,
  requirement: InsuranceRequirement,
  artifactsPathOrUrl = GPC_ARTIFACTS_URL
): Promise<GpcProofEnvelope> => {
  const config = insuranceProofConfig(requirement);
  const policyCommitment = await commitValue(proofConfigToJSON(config));
  const { proof, boundConfig, revealedClaims } = await gpcProve(
    config,
    proofInputs(pod, identity, requirement),
    artifactsPathOrUrl
  );
  const serialized = {
    proof,
    boundConfig: boundConfigToJSON(boundConfig),
    revealedClaims: revealedClaimsToJSON(revealedClaims)
  };
  return {
    version: "attest-gpc-v1",
    ...serialized,
    policyCommitment,
    proofCommitment: await commitValue(serialized),
    circuitIdentifier: boundConfig.circuitIdentifier
  };
};

export const verifyInsuranceRequirement = async (
  envelope: GpcProofEnvelope,
  requirement: InsuranceRequirement,
  artifactsPathOrUrl = GPC_ARTIFACTS_URL
): Promise<boolean> => {
  if (envelope.version !== "attest-gpc-v1") return false;
  const expectedConfig = insuranceProofConfig(requirement);
  const expectedPolicyCommitment = await commitValue(proofConfigToJSON(expectedConfig));
  if (expectedPolicyCommitment !== envelope.policyCommitment) return false;

  const boundConfig = boundConfigFromJSON(envelope.boundConfig);
  const revealedClaims = revealedClaimsFromJSON(envelope.revealedClaims);
  const expectedBoundConfig = gpcBindConfig({
    ...expectedConfig,
    circuitIdentifier: boundConfig.circuitIdentifier
  }).boundConfig;
  if (canonicalJson(boundConfigToJSON(boundConfig)) !== canonicalJson(boundConfigToJSON(expectedBoundConfig))) return false;

  const recomputedProofCommitment = await commitValue({
    proof: envelope.proof,
    boundConfig: envelope.boundConfig,
    revealedClaims: envelope.revealedClaims
  });
  if (recomputedProofCommitment !== envelope.proofCommitment) return false;

  return gpcVerify(envelope.proof, boundConfig, revealedClaims, artifactsPathOrUrl);
};

export const proveInsuranceRequirementEffect = (
  pod: POD,
  identity: Identity,
  requirement: InsuranceRequirement,
  artifactsPathOrUrl = GPC_ARTIFACTS_URL
) => Effect.tryPromise({
  try: () => proveInsuranceRequirement(pod, identity, requirement, artifactsPathOrUrl),
  catch: (cause) => new ProofError("Unable to produce GPC insurance proof", cause)
});

export const verifyInsuranceRequirementEffect = (
  envelope: GpcProofEnvelope,
  requirement: InsuranceRequirement,
  artifactsPathOrUrl = GPC_ARTIFACTS_URL
) => Effect.tryPromise({
  try: () => verifyInsuranceRequirement(envelope, requirement, artifactsPathOrUrl),
  catch: (cause) => new ProofError("Unable to verify GPC insurance proof", cause)
});
