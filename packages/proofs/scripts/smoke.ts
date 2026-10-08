import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  holderPublicKey,
  issueInsurancePod,
  newHolderIdentity,
  proveInsuranceRequirement,
  verifyInsuranceRequirement,
  type InsuranceRequirement
} from "../src/index";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.resolve(here, "../../../node_modules/@pcd/proto-pod-gpc-artifacts");
const identity = newHolderIdentity();
const pod = issueInsurancePod({
  attestationId: "att:smoke",
  subjectBinding: "subject:smoke",
  ownerPublicKey: holderPublicKey(identity),
  aggregateUsd: 5_000_000n,
  perOccurrenceUsd: 2_000_000n,
  validUntilEpochSeconds: 1_830_297_600n,
  additionalInsured: true,
  waiverOfSubrogation: true
}, "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8");

const requirement: InsuranceRequirement = {
  aggregateMinimumUsd: 2_000_000n,
  perOccurrenceMinimumUsd: 1_000_000n,
  validThroughEpochSeconds: 1_800_000_000n,
  requireAdditionalInsured: true,
  requireWaiverOfSubrogation: true,
  challenge: "smoke",
  acceptedIssuerPublicKeys: [pod.signerPublicKey]
};

const envelope = await proveInsuranceRequirement(pod, identity, requirement, artifacts);
if (!(await verifyInsuranceRequirement(envelope, requirement, artifacts))) {
  throw new Error("GPC smoke proof failed verification");
}
console.log(JSON.stringify({ verified: true, circuit: envelope.circuitIdentifier, proof: envelope.proofCommitment }, null, 2));
