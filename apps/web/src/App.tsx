import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, Input } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  EyeIcon,
  EyeSlashIcon,
  FingerprintIcon,
  LockKeyIcon,
  ShieldCheckIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { makeVerificationReceipt } from "@attest/chain-evm";
import { commitAttestation, commitValue, merkleRoot } from "@attest/core";
import {
  createSupplierPolicy,
  defaultThresholds,
  DEMO_INSURANCE_ISSUER_PRIVATE_KEY,
  DEMO_SUBJECT,
  demoAttestations,
  demoAuthorityGraph
} from "@attest/domains";
import type { PolicyEvaluation } from "@attest/policy";
import {
  holderPublicKey,
  issueInsurancePod,
  newHolderIdentity,
  proveInsuranceRequirementEffect,
  verifyInsuranceRequirementEffect,
  type GpcProofEnvelope,
  type InsuranceRequirement
} from "@attest/proofs";
import { createPersona, createPresentationContext, PrivateEvidenceWallet } from "@attest/wallet";
import { Effect } from "effect";

const money = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
}).format(value);

const buildWallet = (): PrivateEvidenceWallet => {
  let wallet = new PrivateEvidenceWallet("root:acme")
    .addPersona(createPersona("persona:compliance", "Compliance", ["insurance.*", "soc2.*", "iso9001.*"]));
  for (const attestation of demoAttestations) wallet = wallet.ingest(attestation, "persona:compliance");
  return wallet;
};

const assuranceContext = createPresentationContext(
  "presentation:project-817",
  "Project 817 assurance",
  ["persona:compliance"],
  ["insurance.*", "soc2.*", "iso9001.*"]
);

export function App() {
  const wallet = useMemo(buildWallet, []);
  const [identity] = useState(newHolderIdentity);
  const [aggregate, setAggregate] = useState(Number(defaultThresholds.aggregateMinimumUsd));
  const [occurrence, setOccurrence] = useState(Number(defaultThresholds.perOccurrenceMinimumUsd));
  const [revealVault, setRevealVault] = useState(false);
  const [evaluation, setEvaluation] = useState<PolicyEvaluation | null>(null);
  const [proofState, setProofState] = useState<"idle" | "proving" | "verified" | "failed">("idle");
  const [proof, setProof] = useState<GpcProofEnvelope | null>(null);
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof makeVerificationReceipt>> | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);

  const thresholds = useMemo(() => ({
    aggregateMinimumUsd: BigInt(Math.max(0, Math.trunc(aggregate || 0))),
    perOccurrenceMinimumUsd: BigInt(Math.max(0, Math.trunc(occurrence || 0))),
    projectEnd: defaultThresholds.projectEnd
  }), [aggregate, occurrence]);

  const profile = useMemo(() => createSupplierPolicy(thresholds), [thresholds]);
  const insurancePod = useMemo(() => issueInsurancePod({
    attestationId: "att:insurance:acme:2027",
    subjectBinding: DEMO_SUBJECT,
    ownerPublicKey: holderPublicKey(identity),
    aggregateUsd: 5_000_000n,
    perOccurrenceUsd: 2_000_000n,
    validUntilEpochSeconds: BigInt(Math.floor(new Date("2027-12-31T23:59:59.000Z").getTime() / 1000)),
    additionalInsured: true,
    waiverOfSubrogation: true
  }, DEMO_INSURANCE_ISSUER_PRIVATE_KEY), [identity]);

  useEffect(() => {
    setProofState("idle");
    setProof(null);
    setReceipt(null);
    setProofError(null);
    void Effect.runPromise(wallet.plan(assuranceContext, profile, demoAuthorityGraph)).then(setEvaluation);
  }, [wallet, profile]);

  const generateProof = async () => {
    setProofState("proving");
    setProofError(null);
    try {
      const challenge = `project-817:${aggregate}:${occurrence}`;
      const requirement: InsuranceRequirement = {
        aggregateMinimumUsd: thresholds.aggregateMinimumUsd,
        perOccurrenceMinimumUsd: thresholds.perOccurrenceMinimumUsd,
        validThroughEpochSeconds: BigInt(Math.floor(new Date(thresholds.projectEnd).getTime() / 1000)),
        requireAdditionalInsured: true,
        requireWaiverOfSubrogation: true,
        challenge,
        acceptedIssuerPublicKeys: [insurancePod.signerPublicKey]
      };
      const program = Effect.flatMap(
        proveInsuranceRequirementEffect(insurancePod, identity, requirement),
        (envelope) => Effect.map(
          verifyInsuranceRequirementEffect(envelope, requirement),
          (valid) => ({ envelope, valid })
        )
      );
      const { envelope, valid } = await Effect.runPromise(program);
      if (!valid) throw new Error("Proof did not verify against the expected policy");

      const evidenceRoot = await merkleRoot(await Promise.all(demoAttestations.map(commitAttestation)));
      const pairwiseNullifier = await commitValue({ challenge, holder: holderPublicKey(identity) });
      const anchored = await makeVerificationReceipt({
        policyId: profile.id,
        policyCommitment: envelope.policyCommitment,
        evidenceRoot,
        proofCommitment: envelope.proofCommitment,
        subjectNullifier: pairwiseNullifier,
        satisfied: true
      });
      setProof(envelope);
      setReceipt(anchored);
      setProofState("verified");
    } catch (error) {
      setProofState("failed");
      setProofError(error instanceof Error ? error.message : String(error));
    }
  };

  const verifiedCount = evaluation?.leaves.filter((leaf) => leaf.satisfied).length ?? 0;
  const totalCount = evaluation?.leaves.length ?? 12;

  return <main className="shell flex flex-col gap-6">
    <header className="flex flex-wrap items-start justify-between gap-5">
      <div className="max-w-3xl">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-kumo-subtle">
          <ShieldCheckIcon className="size-5 text-kumo-brand"/> Attest assurance workbench
        </div>
        <h1 className="m-0 text-4xl font-semibold tracking-tight md:text-5xl">Share the answer, not the file cabinet.</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-kumo-subtle">
          A supplier proves insurance, SOC 2 and ISO 9001 requirements from a private evidence wallet. The buyer receives verifiable predicates—not exact limits or source reports.
        </p>
      </div>
      <div className="flex gap-2">
        <Badge variant="success">Effect 4</Badge>
        <Badge variant="neutral">Kumo UI</Badge>
        <Badge variant="warning">Testnet POC</Badge>
      </div>
    </header>

    <Banner
      variant="secondary"
      size="sm"
      title="Proof backend boundary"
      description="The local planner evaluates all three assurance domains. The Generate GPC proof action produces and verifies a real Groth16 proof for the hidden insurance limits. POD/GPC remains beta and unaudited, so this is not production assurance infrastructure."
    />

    <section className="metric-grid">
      <Metric label="Evidence records" value="3" detail="carrier, CPA, certifier"/>
      <Metric label="Authority roots" value="3" detail="scoped trust chains"/>
      <Metric label="Requirements met" value={`${verifiedCount}/${totalCount}`} detail="without source disclosure"/>
      <Metric label="On-chain payload" value="4 hashes" detail="no raw evidence"/>
    </section>

    <div className="grid gap-5 lg:grid-cols-[1.05fr_1.45fr]">
      <section className="panel p-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-xl font-semibold">Supplier evidence vault</h2>
            <p className="mt-1 text-sm text-kumo-subtle">Private source values remain holder-controlled.</p>
          </div>
          <Button variant="secondary" size="sm" icon={revealVault ? EyeSlashIcon : EyeIcon} onClick={() => setRevealVault((value) => !value)}>
            {revealVault ? "Hide demo values" : "Reveal demo values"}
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          <EvidenceCard title="Commercial general liability" issuer="Carrier authority" status="Active" rows={[
            ["Aggregate limit", revealVault ? "$5,000,000" : "Hidden"],
            ["Per occurrence", revealVault ? "$2,000,000" : "Hidden"],
            ["Valid until", revealVault ? "Dec 31, 2027" : "Predicate-only"],
            ["Evidence", "Committed, not published"]
          ]}/>
          <EvidenceCard title="SOC 2 examination" issuer="CPA firm" status="Current" rows={[
            ["Report", "Type II"],
            ["Period", revealVault ? "12 months" : "≥ 6 months"],
            ["Exceptions", revealVault ? "0 material" : "Requirement satisfied"],
            ["Report body", "Private"]
          ]}/>
          <EvidenceCard title="ISO 9001 certificate" issuer="Accredited certifier" status="Current" rows={[
            ["Scope", revealVault ? "Industrial-controls manufacturing" : "Required scope covered"],
            ["Valid until", revealVault ? "Aug 31, 2029" : "Through project end"],
            ["Authority", "Accreditation chain verified"],
            ["Certificate", "Committed, not published"]
          ]}/>
        </div>
      </section>

      <section className="panel p-5">
        <div className="mb-5">
          <h2 className="m-0 text-xl font-semibold">Buyer requirement policy</h2>
          <p className="mt-1 text-sm text-kumo-subtle">Thresholds are public. The supplier's exact values are not.</p>
        </div>
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          <Input label="CGL aggregate minimum" type="number" min={0} step={500000} value={String(aggregate)} onChange={(event) => setAggregate(Number(event.target.value))} description="Buyer-visible threshold, USD"/>
          <Input label="Per-occurrence minimum" type="number" min={0} step={500000} value={String(occurrence)} onChange={(event) => setOccurrence(Number(event.target.value))} description="Buyer-visible threshold, USD"/>
        </div>

        <div className="mb-5 overflow-hidden rounded-lg border border-kumo-line">
          {(evaluation?.leaves ?? []).map((leaf) => <div key={leaf.id} className="flex items-center gap-3 border-b border-kumo-line px-3 py-2.5 last:border-b-0">
            {leaf.satisfied
              ? <CheckCircleIcon className="size-5 shrink-0 text-kumo-success"/>
              : <WarningCircleIcon className="size-5 shrink-0 text-kumo-danger"/>}
            <span className="min-w-0 flex-1 text-sm">{leaf.label}</span>
            <Badge variant={leaf.satisfied ? "success" : "error"}>{leaf.satisfied ? "verified" : "not met"}</Badge>
          </div>)}
        </div>

        {evaluation !== null && <Banner
          variant={evaluation.satisfied ? "success" : "error"}
          size="sm"
          title={evaluation.satisfied ? "Local evidence plan satisfies the buyer policy" : "The current private evidence does not satisfy the policy"}
          description={evaluation.satisfied
            ? `${evaluation.witnessIds.length} authenticated records cover ${evaluation.leaves.length} requirements. Hidden values are absent from the plan result.`
            : "Raise or change the threshold to see a clean failure without disclosing the supplier's actual limit."}
        />}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={FingerprintIcon} disabled={proofState === "proving" || !evaluation?.satisfied} onClick={() => void generateProof()}>
            {proofState === "proving" ? "Generating Groth16 proof…" : "Generate GPC proof"}
          </Button>
          <span className="text-sm text-kumo-subtle">First run downloads proving artifacts.</span>
        </div>

        {proofState === "failed" && <div className="mt-4"><Banner variant="error" size="sm" title="Proof generation failed" description={proofError ?? "Unknown proof error"}/></div>}
        {proofState === "verified" && proof !== null && receipt !== null && <div className="mt-5 rounded-lg border border-kumo-success/40 bg-kumo-success/5 p-4">
          <div className="flex items-center gap-2"><LockKeyIcon className="size-5 text-kumo-success"/><strong>Cryptographic predicate verified</strong><Badge variant="success">ready to anchor</Badge></div>
          <p className="mb-3 mt-2 text-sm text-kumo-subtle">The verifier learned only that the carrier-signed policy meets the requested limits, endorsements and project date.</p>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <HashRow label="Circuit" value={proof.circuitIdentifier}/>
            <HashRow label="Proof commitment" value={proof.proofCommitment}/>
            <HashRow label="Evidence root" value={receipt.evidenceRoot}/>
            <HashRow label="Pairwise nullifier" value={receipt.subjectNullifier ?? "—"}/>
            <HashRow label="Receipt id" value={receipt.id}/>
            <HashRow label="Policy commitment" value={receipt.policyCommitment}/>
          </div>
        </div>}
      </section>
    </div>

    <section className="panel p-5">
      <h2 className="m-0 text-xl font-semibold">What the chain records</h2>
      <p className="mt-1 text-sm text-kumo-subtle">The Solidity registry anchors evidence and verification receipts while the evidence graph remains private.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        {[
          ["Policy commitment", "Which exact requirement program was verified"],
          ["Evidence root", "A commitment to the selected authenticated records"],
          ["Proof commitment", "The verified GPC presentation transcript"],
          ["Pairwise nullifier", "Replay control scoped to this engagement"]
        ].map(([title, description]) => <div key={title} className="rounded-lg border border-kumo-line p-3">
          <div className="mb-1 font-medium">{title}</div><div className="text-sm text-kumo-subtle">{description}</div>
        </div>)}
      </div>
      <div className="flow-line my-5"/>
      <p className="m-0 text-sm text-kumo-subtle"><strong className="text-kumo-default">Never on-chain:</strong> exact policy limits, report bodies, certificate documents, legal identity, premiums, broker correspondence, or unrelated business evidence.</p>
    </section>
  </main>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="panel p-4"><div className="text-2xl font-semibold">{value}</div><div className="mt-1 text-sm font-medium">{label}</div><div className="mt-1 text-xs text-kumo-subtle">{detail}</div></div>;
}

function EvidenceCard({ title, issuer, status, rows }: { title: string; issuer: string; status: string; rows: readonly (readonly [string, string])[] }) {
  return <div className="rounded-lg border border-kumo-line p-4">
    <div className="mb-3 flex items-start justify-between gap-3"><div><div className="font-medium">{title}</div><div className="text-xs text-kumo-subtle">{issuer}</div></div><Badge variant="success">{status}</Badge></div>
    <dl className="m-0 grid grid-cols-[minmax(8rem,1fr)_1.4fr] gap-x-3 gap-y-2 text-sm">
      {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-kumo-subtle">{label}</dt><dd className="m-0 text-right font-medium">{value}</dd></div>)}
    </dl>
  </div>;
}

function HashRow({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><div className="text-kumo-subtle">{label}</div><code className="block truncate" title={value}>{value}</code></div>;
}
