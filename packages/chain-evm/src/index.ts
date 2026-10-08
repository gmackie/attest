import { commitValue } from "@attest/core";
import type { VerificationReceipt } from "@attest/domain";

export const assuranceAnchorAbi = [
  "function anchorAttestation(bytes32 attestationId,bytes32 evidenceCommitment,bytes32 schemaHash,uint64 validUntil)",
  "function setAttestationStatus(bytes32 attestationId,uint8 status)",
  "function recordVerification(bytes32 policyCommitment,bytes32 evidenceRoot,bytes32 proofCommitment,bytes32 subjectNullifier,bool satisfied) returns (bytes32)",
  "event AttestationAnchored(bytes32 indexed attestationId,address indexed issuer,bytes32 evidenceCommitment,bytes32 schemaHash,uint64 validUntil)",
  "event VerificationRecorded(bytes32 indexed receiptId,bytes32 indexed policyCommitment,bytes32 indexed evidenceRoot,bytes32 proofCommitment,bytes32 subjectNullifier,bool satisfied,address verifier)"
] as const;

export type VerificationAnchorInput = Readonly<{
  policyId: string;
  policyCommitment: string;
  evidenceRoot: string;
  proofCommitment: string;
  subjectNullifier?: string;
  satisfied: boolean;
  verifiedAt?: string;
}>;

export const makeVerificationReceipt = async (input: VerificationAnchorInput): Promise<VerificationReceipt> => {
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const id = await commitValue({ ...input, verifiedAt });
  return {
    id,
    policyId: input.policyId,
    policyCommitment: input.policyCommitment,
    evidenceRoot: input.evidenceRoot,
    proofCommitment: input.proofCommitment,
    ...(input.subjectNullifier === undefined ? {} : { subjectNullifier: input.subjectNullifier }),
    satisfied: input.satisfied,
    verifiedAt
  };
};
