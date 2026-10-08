import { Effect } from "effect";
import { POD, deriveSignerPublicKey } from "@pcd/pod";
import { canonicalJson, commitValue, merkleRoot } from "@attest/core";
import {
  resolveAttestationAuthority,
  type AuthorityResolution,
} from "@attest/authority";
import {
  integerValue,
  dateValue,
  type Attestation,
  type VerificationReceipt,
} from "@attest/domain";
import { createSupplierPolicy, demoAttestations } from "@attest/domains";
import { type PolicyEvaluation, type RequirementProfile } from "@attest/policy";
import {
  PrivateEvidenceWallet,
  createPersona,
  createPresentationContext,
} from "@attest/wallet";
import {
  holderPublicKey,
  newHolderIdentity,
  issueInsurancePod,
  proveInsuranceRequirement,
  verifyInsuranceRequirement,
  type GpcProofEnvelope,
  type InsuranceRequirement,
} from "@attest/proofs";
import { makeVerificationReceipt } from "@attest/chain-evm";
import {
  byRole,
  institution,
  demoPrivateKey,
  networkAuthority,
  supplierCoverage,
} from "./network";
export * from "./network";

export const scenarios = [
  {
    id: "healthy",
    label: "Successful onboarding",
    description: "Current, signed records from trusted institutions.",
  },
  {
    id: "insufficient",
    label: "Insufficient coverage",
    description:
      "The request asks for $20M. No supplier in this network qualifies.",
  },
  {
    id: "expired",
    label: "Expired insurance",
    description: "A genuine signature cannot make expired evidence current.",
  },
  {
    id: "untrusted",
    label: "Untrusted insurer",
    description:
      "The carrier signs correctly, but its authority grant is removed.",
  },
  {
    id: "tampered",
    label: "Tampered record",
    description: "The insurance amount is changed after the issuer signs it.",
  },
  {
    id: "wrong-subject",
    label: "Wrong supplier",
    description:
      "The insurance credential belongs to a different legal subject.",
  },
  {
    id: "revoked",
    label: "Revoked insurance",
    description: "The synthetic local status marks the policy revoked.",
  },
] as const;
export type ScenarioId = (typeof scenarios)[number]["id"];
export type DemoConfig = Readonly<{
  supplier: string;
  buyer: string;
  insurer: string;
  auditor: string;
  certifier: string;
  scenario: ScenarioId;
  aggregate: number;
  occurrence: number;
}>;
export const defaultConfig: DemoConfig = {
  supplier: "supplier:acme",
  buyer: "buyer:northstar",
  insurer: "insurer:harbor",
  auditor: "auditor:cedar",
  certifier: "certifier:verdant",
  scenario: "healthy",
  aggregate: 2_000_000,
  occurrence: 1_000_000,
};
export const steps = [
  {
    title: "Define the request",
    actor: "Buyer",
    component: "Requirement policy",
    explanation:
      "The buyer chooses the supplier, thresholds, accepted authority roots and a fresh challenge. These define exactly what this presentation must prove.",
    boundary:
      "Public: buyer, subject binding, requirements and request challenge.",
  },
  {
    title: "Issue signed evidence",
    actor: "Institutions",
    component: "Attestation",
    explanation:
      "The selected insurer, auditor and certification body each sign their own record with a distinct demo key. A signature authenticates the record; it does not establish authority.",
    boundary:
      "Private: source records, exact limits and each issuer's signature.",
  },
  {
    title: "Resolve authority",
    actor: "Trust network",
    component: "Authority graph",
    explanation:
      "Every claim is checked against a scoped path to a buyer-accepted root. Certification follows two edges through Meridian Accreditation. Signature validation also catches modified records.",
    boundary:
      "Local checks: signature integrity, authorized action, schema, scope and delegation.",
  },
  {
    title: "Build the private wallet",
    actor: "Supplier",
    component: "Persona wallet",
    explanation:
      "Authenticated records enter the supplier's compliance persona. The wallet projects only the namespaces allowed for this presentation; it does not send the records to the buyer.",
    boundary: "Private: all three records remain in browser memory.",
  },
  {
    title: "Match the policy",
    actor: "Planner",
    component: "Coherent witness",
    explanation:
      "The planner checks subject, status, dates and all 12 requirements. Each domain must be supported by a single coherent record. A failure stops the flow before proof generation.",
    boundary:
      "Local evaluation is not a zero-knowledge proof. Failed requirements stay failed.",
  },
  {
    title: "Generate a private proof",
    actor: "Supplier",
    component: "POD / GPC prover",
    explanation:
      "A real Groth16 proof establishes the hidden insurance limits, required endorsements, subject, currency, accepted signer and validity threshold. This step performs actual cryptographic computation.",
    boundary:
      "The insurance proof hides exact limits and the selected signer. Public inputs include the accepted issuer set and subject binding.",
  },
  {
    title: "Verify & create a receipt",
    actor: "Buyer",
    component: "Verifier & commitments",
    explanation:
      "The buyer checks the proof against its original request. A successful result produces a receipt and transcript commitment. Reusing the proof for another challenge must fail.",
    boundary:
      "Insurance is cryptographically verified. SOC 2 / ISO 9001 remain local checks. Receipt metadata is prepared locally; no blockchain transaction is submitted.",
  },
] as const;
export type SignedRecord = Readonly<{
  attestation: Attestation;
  signedPod: ReturnType<POD["toJSON"]>;
}>;
export type DemoRun = Readonly<{
  config: DemoConfig;
  id: string;
  completed: number;
  identity: ReturnType<typeof newHolderIdentity>;
  profile?: RequirementProfile;
  requirement?: InsuranceRequirement;
  records?: readonly SignedRecord[];
  insurancePod?: POD;
  authority?: readonly { recordId: string; resolution: AuthorityResolution }[];
  wallet?: PrivateEvidenceWallet;
  evaluation?: PolicyEvaluation;
  proof?: GpcProofEnvelope;
  receipt?: VerificationReceipt;
  events: readonly { step: number; message: string; time: string }[];
}>;
export class DemoStepError extends Error {
  readonly _tag = "DemoStepError";
  constructor(
    message: string,
    readonly evaluation?: PolicyEvaluation,
  ) {
    super(message);
  }
}
export const createRun = (config: DemoConfig = defaultConfig): DemoRun => {
  for (const key of [
    "supplier",
    "buyer",
    "insurer",
    "auditor",
    "certifier",
  ] as const) {
    if (institution(config[key]).role !== key)
      throw new Error(`Invalid ${key}`);
  }
  if (
    ![config.aggregate, config.occurrence].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new Error("Thresholds must be non-negative whole USD amounts");
  return {
    config: { ...config },
    id: globalThis.crypto.randomUUID(),
    completed: 0,
    identity: newHolderIdentity(),
    events: [],
  };
};
export const signRecord = (attestation: Attestation): SignedRecord => ({
  attestation,
  signedPod: POD.sign(
    { record: { type: "string", value: canonicalJson(attestation) } },
    demoPrivateKey(attestation.issuer),
  ).toJSON(),
});
export const authenticateRecord = (record: SignedRecord): boolean => {
  try {
    const pod = POD.fromJSON(record.signedPod);
    return (
      pod.verifySignature() &&
      pod.signerPublicKey ===
        deriveSignerPublicKey(demoPrivateKey(record.attestation.issuer)) &&
      pod.content.getValue("record")?.value ===
        canonicalJson(record.attestation)
    );
  } catch {
    return false;
  }
};
export const graphFor = (config: DemoConfig) =>
  config.scenario === "untrusted"
    ? {
        ...networkAuthority,
        grants: networkAuthority.grants.filter(
          (grant) => grant.grantee !== config.insurer,
        ),
      }
    : networkAuthority;
const finish = (
  run: DemoRun,
  patch: Partial<DemoRun>,
  message: string,
): DemoRun => ({
  ...run,
  ...patch,
  completed: run.completed + 1,
  events: [
    ...run.events,
    { step: run.completed, message, time: new Date().toISOString() },
  ],
});

const advance = async (run: DemoRun, artifacts?: string): Promise<DemoRun> => {
  const { config } = run;
  switch (run.completed) {
    case 0: {
      const aggregate =
        config.scenario === "insufficient" ? 20_000_000 : config.aggregate;
      const profile = {
        ...createSupplierPolicy({
          aggregateMinimumUsd: BigInt(aggregate),
          perOccurrenceMinimumUsd: BigInt(config.occurrence),
          projectEnd: "2027-06-30T00:00:00Z",
        }),
        id: `policy:${config.buyer}:${run.id}`,
        subject: config.supplier,
        acceptedRoots: networkAuthority.acceptedRoots,
      };
      const requirement: InsuranceRequirement = {
        subjectBinding: config.supplier,
        aggregateMinimumUsd: BigInt(aggregate),
        perOccurrenceMinimumUsd: BigInt(config.occurrence),
        validThroughEpochSeconds: BigInt(
          Date.parse("2027-06-30T00:00:00Z") / 1000,
        ),
        requireAdditionalInsured: true,
        requireWaiverOfSubrogation: true,
        challenge: `${config.buyer}:${run.id}`,
        acceptedIssuerPublicKeys: byRole("insurer").map(({ id }) =>
          deriveSignerPublicKey(demoPrivateKey(id)),
        ),
      };
      return finish(
        run,
        { profile, requirement },
        `${institution(config.buyer).name} created a fresh request for ${institution(config.supplier).name}.`,
      );
    }
    case 1: {
      const [aggregate, occurrence] = supplierCoverage[config.supplier]!;
      const records = await Promise.all(
        demoAttestations.map(async (base, index) => {
          const issuer = [config.insurer, config.auditor, config.certifier][
            index
          ]!;
          const subject =
            index === 0 && config.scenario === "wrong-subject"
              ? "supplier:unrelated"
              : config.supplier;
          const validUntil =
            index === 0 && config.scenario === "expired"
              ? "2026-01-01T00:00:00Z"
              : base.validUntil!;
          const claims =
            index === 0
              ? {
                  ...base.claims,
                  "insurance.cgl.aggregate": integerValue(aggregate, "USD"),
                  "insurance.cgl.perOccurrence": integerValue(
                    occurrence,
                    "USD",
                  ),
                  "insurance.validUntil": dateValue(validUntil),
                }
              : base.claims;
          const attestation: Attestation = {
            ...base,
            id: `att:${run.id}:${index}`,
            subject,
            issuer,
            claims,
            validUntil,
            status:
              index === 0 && config.scenario === "revoked"
                ? "revoked"
                : "active",
            evidence: [
              {
                id: `source:${run.id}:${index}`,
                kind: "document-commitment",
                commitment: await commitValue({ subject, issuer, claims }),
                source: `Synthetic ${institution(issuer).name} record`,
              },
            ],
          };
          return signRecord(attestation);
        }),
      );
      const insurance = records[0]!.attestation;
      const insurancePod = issueInsurancePod(
        {
          attestationId: insurance.id,
          subjectBinding: insurance.subject,
          ownerPublicKey: holderPublicKey(run.identity),
          aggregateUsd: BigInt(aggregate),
          perOccurrenceUsd: BigInt(occurrence),
          validUntilEpochSeconds: BigInt(
            Date.parse(insurance.validUntil!) / 1000,
          ),
          additionalInsured: true,
          waiverOfSubrogation: true,
        },
        demoPrivateKey(config.insurer),
      );
      const finalRecords =
        config.scenario === "tampered"
          ? records.map((record, index) =>
              index === 0
                ? {
                    ...record,
                    attestation: {
                      ...record.attestation,
                      claims: {
                        ...record.attestation.claims,
                        "insurance.cgl.aggregate": integerValue(
                          99_000_000,
                          "USD",
                        ),
                      },
                    },
                  }
                : record,
            )
          : records;
      return finish(
        run,
        { records: finalRecords, insurancePod },
        "Three institutions signed three distinct records. Insurance also received a holder-bound POD credential.",
      );
    }
    case 2: {
      const authority = run.records!.map((record) => {
        if (!authenticateRecord(record))
          throw new DemoStepError(
            `${institution(record.attestation.issuer).name}: signed record integrity check failed. The record changed after issuance.`,
          );
        const resolutions = Object.keys(record.attestation.claims).map(
          (predicate) =>
            resolveAttestationAuthority(
              graphFor(config),
              record.attestation,
              predicate,
              run.profile!.evaluatedAt,
              run.profile!.acceptedRoots,
            ),
        );
        const failed = resolutions.find((result) => !result.authorized);
        if (failed)
          throw new DemoStepError(
            `${institution(record.attestation.issuer).name}: no accepted authority path. A valid signature is not enough.`,
          );
        return { recordId: record.attestation.id, resolution: resolutions[0]! };
      });
      return finish(
        run,
        { authority },
        "All signatures and scoped authority paths validated, including the two-hop certification chain.",
      );
    }
    case 3: {
      let wallet = new PrivateEvidenceWallet(
        `wallet:${config.supplier}`,
      ).addPersona(
        createPersona("compliance", "Compliance", [
          "insurance.*",
          "soc2.*",
          "iso9001.*",
        ]),
      );
      for (const record of run.records!)
        wallet = wallet.ingest(record.attestation, "compliance");
      return finish(
        run,
        { wallet },
        "Three authenticated records entered the private compliance persona. No source record was sent to the buyer.",
      );
    }
    case 4: {
      const evaluation = await Effect.runPromise(
        run.wallet!.plan(
          createPresentationContext(
            run.id,
            "Buyer presentation",
            ["compliance"],
            ["insurance.*", "soc2.*", "iso9001.*"],
          ),
          run.profile!,
          graphFor(config),
        ),
      );
      if (!evaluation.satisfied)
        throw new DemoStepError(
          "The private evidence does not satisfy this buyer's policy. Check coverage, subject, validity and status. No proof was generated.",
          evaluation,
        );
      return finish(
        run,
        { evaluation },
        `${evaluation.leaves.length} requirements matched using ${evaluation.witnessIds.length} coherent signed records.`,
      );
    }
    case 5: {
      const proof = await proveInsuranceRequirement(
        run.insurancePod!,
        run.identity,
        run.requirement!,
        artifacts,
      );
      return finish(
        run,
        { proof },
        "A real Groth16 insurance proof was generated. Verification has not happened yet.",
      );
    }
    case 6: {
      if (
        !(await verifyInsuranceRequirement(
          run.proof!,
          run.requirement!,
          artifacts,
        ))
      )
        throw new DemoStepError(
          "The proof did not verify against the original buyer request.",
        );
      const selected = run.records!.filter(({ attestation }) =>
        run.evaluation!.witnessIds.includes(attestation.id),
      );
      // Local evidence root is metadata, not a GPC-proven cross-domain commitment.
      const evidenceRoot = await merkleRoot(
        await Promise.all(
          selected.map(({ attestation }) => commitValue(attestation)),
        ),
      );
      const subjectNullifier = await commitValue(
        run.proof!.revealedClaims.owner,
      );
      const receipt = await makeVerificationReceipt({
        policyId: run.profile!.id,
        policyCommitment: run.proof!.policyCommitment,
        evidenceRoot,
        proofCommitment: run.proof!.proofCommitment,
        subjectNullifier,
        satisfied: true,
      });
      return finish(
        run,
        { receipt },
        `${institution(config.buyer).name} verified the insurance proof and created a local receipt. No on-chain transaction was sent.`,
      );
    }
    default:
      throw new DemoStepError(
        "This run is already complete. Reset to start another request.",
      );
  }
};
export const advanceRun = (run: DemoRun, artifacts?: string) =>
  Effect.tryPromise({
    try: () => advance(run, artifacts),
    catch: (cause) =>
      cause instanceof DemoStepError
        ? cause
        : new DemoStepError(
            cause instanceof Error ? cause.message : String(cause),
          ),
  });
export const checkReplay = (run: DemoRun, artifacts?: string) =>
  Effect.tryPromise({
    try: () => {
      if (!run.proof || !run.requirement)
        throw new Error("Generate a proof first");
      return verifyInsuranceRequirement(
        run.proof,
        {
          ...run.requirement,
          challenge: `${run.requirement.challenge}:different-request`,
        },
        artifacts,
      );
    },
    catch: (cause) => new DemoStepError(String(cause)),
  });
export const publicPresentation = (run: DemoRun) => {
  if (!run.receipt || !run.proof || !run.requirement)
    throw new Error("Complete verification before exporting");
  return {
    version: "attest-demo-presentation-v1",
    scope: {
      insurance: "GPC cryptographic proof",
      soc2: "local signed-record policy check",
      iso9001: "local signed-record policy check",
      evidenceRoot: "locally computed metadata; not bound by GPC",
      chain: "not submitted",
    },
    buyer: run.config.buyer,
    request: {
      ...run.requirement,
      aggregateMinimumUsd: run.requirement.aggregateMinimumUsd.toString(),
      perOccurrenceMinimumUsd:
        run.requirement.perOccurrenceMinimumUsd.toString(),
      validThroughEpochSeconds:
        run.requirement.validThroughEpochSeconds.toString(),
    },
    proof: run.proof,
    receipt: run.receipt,
  };
};

export * from "./industries";
