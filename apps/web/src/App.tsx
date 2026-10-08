import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  BuildingsIcon,
  CertificateIcon,
  CheckIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  EyeIcon,
  EyeSlashIcon,
  FileLockIcon,
  FingerprintIcon,
  GlobeHemisphereWestIcon,
  GridFourIcon,
  LockKeyIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { makeVerificationReceipt } from "@attest/chain-evm";
import { commitAttestation, commitValue, merkleRoot } from "@attest/core";
import {
  createSupplierPolicy,
  defaultThresholds,
  DEMO_INSURANCE_ISSUER_PRIVATE_KEY,
  DEMO_SUBJECT,
  demoAttestations,
  demoAuthorityGraph,
} from "@attest/domains";
import type { PolicyEvaluation } from "@attest/policy";
import {
  holderPublicKey,
  issueInsurancePod,
  newHolderIdentity,
  proveInsuranceRequirementEffect,
  verifyInsuranceRequirementEffect,
  type GpcProofEnvelope,
  type InsuranceRequirement,
} from "@attest/proofs";
import {
  createPersona,
  createPresentationContext,
  PrivateEvidenceWallet,
} from "@attest/wallet";
import { Effect } from "effect";

const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

const buildWallet = (): PrivateEvidenceWallet => {
  let wallet = new PrivateEvidenceWallet("root:acme").addPersona(
    createPersona("persona:compliance", "Compliance", [
      "insurance.*",
      "soc2.*",
      "iso9001.*",
    ]),
  );
  for (const attestation of demoAttestations)
    wallet = wallet.ingest(attestation, "persona:compliance");
  return wallet;
};

const assuranceContext = createPresentationContext(
  "presentation:project-817",
  "Project 817 assurance",
  ["persona:compliance"],
  ["insurance.*", "soc2.*", "iso9001.*"],
);

export function App() {
  const wallet = useMemo(buildWallet, []);
  const [identity] = useState(newHolderIdentity);
  const [aggregate, setAggregate] = useState(
    Number(defaultThresholds.aggregateMinimumUsd),
  );
  const [occurrence, setOccurrence] = useState(
    Number(defaultThresholds.perOccurrenceMinimumUsd),
  );
  const [revealVault, setRevealVault] = useState(false);
  const [activeSection, setActiveSection] = useState("overview");
  const [evaluation, setEvaluation] = useState<PolicyEvaluation | null>(null);
  const [proofState, setProofState] = useState<
    "idle" | "proving" | "verified" | "failed"
  >("idle");
  const [proof, setProof] = useState<GpcProofEnvelope | null>(null);
  const [receipt, setReceipt] = useState<Awaited<
    ReturnType<typeof makeVerificationReceipt>
  > | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);

  const thresholds = useMemo(
    () => ({
      aggregateMinimumUsd: BigInt(Math.max(0, Math.trunc(aggregate || 0))),
      perOccurrenceMinimumUsd: BigInt(Math.max(0, Math.trunc(occurrence || 0))),
      projectEnd: defaultThresholds.projectEnd,
    }),
    [aggregate, occurrence],
  );

  const profile = useMemo(() => createSupplierPolicy(thresholds), [thresholds]);
  const insurancePod = useMemo(
    () =>
      issueInsurancePod(
        {
          attestationId: "att:insurance:acme:2027",
          subjectBinding: DEMO_SUBJECT,
          ownerPublicKey: holderPublicKey(identity),
          aggregateUsd: 5_000_000n,
          perOccurrenceUsd: 2_000_000n,
          validUntilEpochSeconds: BigInt(
            Math.floor(new Date("2027-12-31T23:59:59.000Z").getTime() / 1000),
          ),
          additionalInsured: true,
          waiverOfSubrogation: true,
        },
        DEMO_INSURANCE_ISSUER_PRIVATE_KEY,
      ),
    [identity],
  );

  useEffect(() => {
    setProofState("idle");
    setProof(null);
    setReceipt(null);
    setProofError(null);
    let active = true;
    void Effect.runPromise(
      wallet.plan(assuranceContext, profile, demoAuthorityGraph),
    ).then((result) => {
      if (active) setEvaluation(result);
    });
    return () => {
      active = false;
    };
  }, [wallet, profile]);

  const updateThreshold = (
    value: string,
    current: number,
    update: (value: number) => void,
  ) => {
    const next = Number(value);
    if (!Number.isSafeInteger(next) || next < 0 || next === current) return;
    setEvaluation(null);
    setProofState("idle");
    setProof(null);
    setReceipt(null);
    setProofError(null);
    update(next);
  };

  const generateProof = async () => {
    if (!evaluation?.satisfied || proofState === "proving") return;
    setProofState("proving");
    setProofError(null);
    try {
      const challenge = `project-817:${aggregate}:${occurrence}`;
      const requirement: InsuranceRequirement = {
        subjectBinding: DEMO_SUBJECT,
        aggregateMinimumUsd: thresholds.aggregateMinimumUsd,
        perOccurrenceMinimumUsd: thresholds.perOccurrenceMinimumUsd,
        validThroughEpochSeconds: BigInt(
          Math.floor(new Date(thresholds.projectEnd).getTime() / 1000),
        ),
        requireAdditionalInsured: true,
        requireWaiverOfSubrogation: true,
        challenge,
        acceptedIssuerPublicKeys: [insurancePod.signerPublicKey],
      };
      const program = Effect.flatMap(
        proveInsuranceRequirementEffect(insurancePod, identity, requirement),
        (envelope) =>
          Effect.map(
            verifyInsuranceRequirementEffect(envelope, requirement),
            (valid) => ({ envelope, valid }),
          ),
      );
      const { envelope, valid } = await Effect.runPromise(program);
      if (!valid)
        throw new Error("Proof did not verify against the expected policy");

      const evidenceRoot = await merkleRoot(
        await Promise.all(demoAttestations.map(commitAttestation)),
      );
      const pairwiseNullifier = await commitValue({
        challenge,
        holder: holderPublicKey(identity),
      });
      const anchored = await makeVerificationReceipt({
        policyId: profile.id,
        policyCommitment: envelope.policyCommitment,
        evidenceRoot,
        proofCommitment: envelope.proofCommitment,
        subjectNullifier: pairwiseNullifier,
        satisfied: true,
      });
      setProof(envelope);
      setReceipt(anchored);
      setProofState("verified");
    } catch (error) {
      setProofState("failed");
      setProofError(error instanceof Error ? error.message : String(error));
    }
  };

  const verifiedCount =
    evaluation?.leaves.filter((leaf) => leaf.satisfied).length ?? 0;
  const totalCount = evaluation?.leaves.length ?? 12;

  const isProving = proofState === "proving";
  const isVerified =
    proofState === "verified" && proof !== null && receipt !== null;
  const groups = [
    {
      name: "Insurance",
      detail: "Limits, endorsements & coverage period",
      prefix: "insurance.",
      icon: ShieldCheckIcon,
    },
    {
      name: "SOC 2",
      detail: "Type II report & security controls",
      prefix: "soc2.",
      icon: FileLockIcon,
    },
    {
      name: "ISO 9001",
      detail: "Certification, scope & validity",
      prefix: "iso9001.",
      icon: CertificateIcon,
    },
  ];
  const setScenario = (nextAggregate: number, nextOccurrence: number) => {
    updateThreshold(String(nextAggregate), aggregate, setAggregate);
    updateThreshold(String(nextOccurrence), occurrence, setOccurrence);
  };
  const downloadReceipt = () => {
    if (!proof || !receipt) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            scope: "Insurance proof; SOC 2 and ISO 9001 evaluated locally only",
            proof,
            receipt,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "attest-project-817.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="brand" href="#overview" aria-label="Attest home">
          <span className="brand-mark">
            <ShieldCheckIcon weight="bold" />
          </span>
          attest<span className="brand-period">.</span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-avatar">A</span>
          <div>
            Acme Industrial<span>Demo workspace</span>
          </div>
          <span className="workspace-dot" />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {[
            { id: "overview", label: "Overview", icon: GridFourIcon },
            { id: "evidence", label: "Evidence vault", icon: FileLockIcon },
            {
              id: "policy",
              label: "Buyer requirements",
              icon: SlidersHorizontalIcon,
            },
            {
              id: "presentation",
              label: "Proof & receipt",
              icon: FingerprintIcon,
            },
          ].map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-label={label}
              className={`nav-item ${activeSection === id ? "active" : ""}`}
              aria-current={activeSection === id ? "location" : undefined}
              onClick={() => setActiveSection(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "evidence" && <span className="nav-count">3</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <LockKeyIcon size={20} />
            <strong>Private by design.</strong>
            <p>
              Your evidence stays in your browser. Share only what’s needed.
            </p>
          </div>
          <a
            className="source-link"
            href="https://github.com/gmackie/attest"
            target="_blank"
            rel="noreferrer"
          >
            Explore the protocol
            <ArrowSquareOutIcon size={15} />
          </a>
          <div className="sidebar-profile">
            <span className="profile-avatar">AI</span>
            <div>
              Acme Industrial<span>Supplier workspace</span>
            </div>
          </div>
        </div>
      </aside>

      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace<span>/</span>
            <strong>Supplier assurance</strong>
          </div>
          <span className="demo-tag">
            <span />
            Interactive demo
          </span>
        </header>
        <main id="main" className="main-content">
          <section id="overview" className="overview">
            <div className="page-heading">
              <div>
                <div className="eyebrow">ASSURANCE, WITHOUT EXPOSURE</div>
                <h1>Trust, with less disclosure.</h1>
                <p>Prove you meet the requirements. Keep the evidence yours.</p>
              </div>
              <a className="text-link" href="#how-it-works">
                How it works
                <ArrowDownIcon size={15} />
              </a>
            </div>
            <div className="engagement-card">
              <div className="engagement-info">
                <div className="project-label">
                  <span className="live-dot" />
                  PROJECT 817 <span className="project-divider">/</span>{" "}
                  SUPPLIER ONBOARDING
                </div>
                <h2>
                  A stronger signal.
                  <br />A smaller footprint.
                </h2>
                <p>
                  One private evidence wallet.
                  <br />A clear answer to your buyer’s requirements.
                </p>
                <div className="engagement-meta">
                  <BuildingsIcon size={16} />
                  Acme Industrial Controls<span className="meta-dot">·</span>
                  <span>Synthetic supplier</span>
                </div>
              </div>
              <div
                className="trust-illustration"
                aria-label="Private evidence becomes a proof for the buyer"
              >
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="diagram-node node-evidence">
                  <FileLockIcon size={24} />
                  <span>Private evidence</span>
                  <small>Stays with you</small>
                </div>
                <div className="diagram-connector">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="diagram-seal">
                  <ShieldCheckIcon size={40} weight="light" />
                  <span>attest</span>
                </div>
                <div className="diagram-connector">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="diagram-node node-proof">
                  <FingerprintIcon size={26} />
                  <span>Verifiable proof</span>
                  <small>Shared with the buyer</small>
                </div>
                <div className="diagram-caption">
                  <LockKeyIcon size={12} /> Evidence stays private. Confidence
                  travels.
                </div>
              </div>
            </div>
            <div className="summary-strip">
              <div>
                <span className="summary-icon">
                  <FileLockIcon />
                </span>
                <strong>03</strong>
                <span>private records</span>
              </div>
              <div>
                <span className="summary-icon">
                  <ShieldCheckIcon />
                </span>
                <strong>03</strong>
                <span>authority roots</span>
              </div>
              <div>
                <span
                  className={`summary-icon ${evaluation && !evaluation.satisfied ? "warning" : ""}`}
                >
                  <CheckCircleIcon />
                </span>
                <strong>
                  {evaluation ? `${verifiedCount}/${totalCount}` : "—"}
                </strong>
                <span>requirements matched</span>
              </div>
              <div>
                <span className="summary-icon">
                  <EyeSlashIcon />
                </span>
                <strong>0</strong>
                <span>source files shared</span>
              </div>
            </div>
          </section>

          <div className="assurance-grid">
            <section id="evidence" className="panel evidence-panel">
              <div className="section-heading">
                <div>
                  <div className="step-label">
                    01 <span>THE SUPPLIER</span>
                  </div>
                  <h2>Your evidence vault</h2>
                  <p>Three records. Always in your control.</p>
                </div>
                <span className="icon-tile">
                  <LockKeyIcon size={21} />
                </span>
              </div>
              <div className="vault-toolbar">
                <span>
                  <span className="status-dot" />
                  Private to this workspace
                </span>
                <button
                  className="icon-button"
                  aria-label={
                    revealVault ? "Hide demo values" : "Reveal demo values"
                  }
                  aria-pressed={revealVault}
                  onClick={() => setRevealVault((value) => !value)}
                >
                  {revealVault ? (
                    <EyeSlashIcon size={17} />
                  ) : (
                    <EyeIcon size={17} />
                  )}
                  <span>{revealVault ? "Hide values" : "Reveal values"}</span>
                </button>
              </div>
              <EvidenceCard
                kind="insurance"
                title="General liability"
                issuer="Carrier-issued insurance"
                icon={ShieldCheckIcon}
                reveal={revealVault}
                rows={[
                  ["Aggregate limit", "$5,000,000"],
                  ["Per occurrence", "$2,000,000"],
                  ["Valid through", "Dec 31, 2027"],
                ]}
              />
              <EvidenceCard
                kind="audit"
                title="SOC 2 Type II"
                issuer="Independent CPA examination"
                icon={FileLockIcon}
                reveal={revealVault}
                rows={[
                  ["Report period", "12 months"],
                  ["Material exceptions", "0"],
                  ["Security controls", "In scope"],
                ]}
              />
              <EvidenceCard
                kind="certification"
                title="ISO 9001"
                issuer="Accredited certification body"
                icon={CertificateIcon}
                reveal={revealVault}
                rows={[
                  ["Scope", "Industrial controls"],
                  ["Valid through", "Aug 31, 2029"],
                  ["Edition", "2015"],
                ]}
              />
              <div className="vault-footnote">
                <LockKeyIcon size={14} />
                <p>
                  These are synthetic demo records. Revealing values here does
                  not add them to the proof.
                </p>
              </div>
            </section>

            <section id="policy" className="panel policy-panel">
              <div className="section-heading">
                <div>
                  <div className="step-label">
                    02 <span>THE BUYER</span>
                  </div>
                  <h2>Set the standard</h2>
                  <p>Define what you need to know. Nothing more.</p>
                </div>
                <span className="subtle-tag">Project 817</span>
              </div>
              <fieldset className="scenario-fieldset" disabled={isProving}>
                <legend>TRY A REQUIREMENT</legend>
                <div className="scenario-options">
                  {[
                    {
                      label: "Standard",
                      aggregate: 2_000_000,
                      occurrence: 1_000_000,
                    },
                    {
                      label: "Higher coverage",
                      aggregate: 5_000_000,
                      occurrence: 2_000_000,
                    },
                    {
                      label: "Beyond coverage",
                      aggregate: 10_000_000,
                      occurrence: 2_000_000,
                    },
                  ].map((scenario) => (
                    <button
                      key={scenario.label}
                      className={
                        aggregate === scenario.aggregate &&
                        occurrence === scenario.occurrence
                          ? "selected"
                          : ""
                      }
                      aria-pressed={
                        aggregate === scenario.aggregate &&
                        occurrence === scenario.occurrence
                      }
                      onClick={() =>
                        setScenario(scenario.aggregate, scenario.occurrence)
                      }
                    >
                      {scenario.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="threshold-grid">
                <label htmlFor="aggregate">
                  CGL aggregate minimum
                  <div className="currency-input">
                    <span>$</span>
                    <input
                      id="aggregate"
                      type="number"
                      min="0"
                      step="500000"
                      disabled={isProving}
                      value={aggregate}
                      onChange={(event) =>
                        updateThreshold(
                          event.target.value,
                          aggregate,
                          setAggregate,
                        )
                      }
                    />
                    <span>USD</span>
                  </div>
                </label>
                <label htmlFor="occurrence">
                  Per-occurrence minimum
                  <div className="currency-input">
                    <span>$</span>
                    <input
                      id="occurrence"
                      type="number"
                      min="0"
                      step="500000"
                      disabled={isProving}
                      value={occurrence}
                      onChange={(event) =>
                        updateThreshold(
                          event.target.value,
                          occurrence,
                          setOccurrence,
                        )
                      }
                    />
                    <span>USD</span>
                  </div>
                </label>
              </div>
              <div className="policy-caption">
                <GlobeHemisphereWestIcon size={13} />
                Buyer thresholds are public. Exact supplier limits stay private.
              </div>
              <div className="requirements-heading">
                <span>REQUIREMENT CHECK</span>
                <span>Local evaluation</span>
              </div>
              <div className="requirement-groups">
                {groups.map(({ name, detail, prefix, icon: Icon }) => {
                  const leaves =
                    evaluation?.leaves.filter((leaf) =>
                      leaf.predicate.startsWith(prefix),
                    ) ?? [];
                  const matched =
                    leaves.length > 0 && leaves.every((leaf) => leaf.satisfied);
                  return (
                    <details className="requirement-group" key={name}>
                      <summary>
                        <span className="domain-icon">
                          <Icon size={20} />
                        </span>
                        <span className="domain-name">
                          <strong>{name}</strong>
                          <small>{detail}</small>
                        </span>
                        <span
                          className={`domain-result ${evaluation ? (matched ? "matched" : "unmatched") : ""}`}
                        >
                          {evaluation ? (
                            matched ? (
                              <>
                                <CheckIcon size={13} />
                                Matched
                              </>
                            ) : (
                              <>
                                <WarningCircleIcon size={14} />
                                Not met
                              </>
                            )
                          ) : (
                            "Checking"
                          )}
                        </span>
                        <span className="disclosure-chevron">⌄</span>
                      </summary>
                      <ul>
                        {leaves.map((leaf) => (
                          <li key={leaf.id}>
                            {leaf.satisfied ? (
                              <CheckCircleIcon size={15} />
                            ) : (
                              <WarningCircleIcon size={15} />
                            )}
                            <span>{leaf.label}</span>
                            <span>{leaf.satisfied ? "Met" : "Not met"}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  );
                })}
              </div>
              <div
                className={`policy-outcome ${evaluation && !evaluation.satisfied ? "outcome-warning" : ""}`}
                role="status"
              >
                {evaluation?.satisfied ? (
                  <CheckCircleIcon size={20} weight="fill" />
                ) : (
                  <WarningCircleIcon size={20} />
                )}
                <div>
                  <strong>
                    {evaluation
                      ? evaluation.satisfied
                        ? "Your evidence meets the requirements"
                        : "This request exceeds the available evidence"
                      : "Checking your evidence…"}
                  </strong>
                  <p>
                    {evaluation?.satisfied
                      ? "Ready to prove your insurance coverage privately."
                      : "Try a lower threshold. The source values remain hidden."}
                  </p>
                </div>
              </div>
              <button
                className="primary-button"
                disabled={isProving || !evaluation?.satisfied}
                onClick={() => {
                  setActiveSection("presentation");
                  document
                    .getElementById("presentation")
                    ?.scrollIntoView({ block: "start" });
                  void generateProof();
                }}
              >
                {isProving ? (
                  <CircleNotchIcon size={20} className="spinning" />
                ) : (
                  <FingerprintIcon size={20} />
                )}
                <span>
                  {isProving
                    ? "Creating your private proof…"
                    : isVerified
                      ? "Generate a new proof"
                      : "Generate private proof"}
                </span>
                {!isProving && <ArrowRightIcon size={19} />}
              </button>
              <p className="button-note">
                Insurance proof generated and verified in your browser.
              </p>
            </section>
          </div>

          <section
            id="presentation"
            className={`presentation-panel ${isVerified ? "presentation-verified" : ""}`}
            aria-busy={isProving}
          >
            <div className="section-heading">
              <div>
                <div className="step-label">
                  03 <span>THE PRESENTATION</span>
                </div>
                <h2>
                  {isVerified
                    ? "Confidence, delivered."
                    : "Your proof. Their confidence."}
                </h2>
                <p>
                  {isVerified
                    ? "Your insurance proof was cryptographically verified."
                    : "The buyer gets an answer, without receiving your source files."}
                </p>
              </div>
              <span
                className={`proof-status ${isVerified ? "proof-success" : ""}`}
              >
                <span />
                {isVerified
                  ? "Proof verified"
                  : isProving
                    ? "Generating proof"
                    : proofState === "failed"
                      ? "Needs attention"
                      : "Awaiting proof"}
              </span>
            </div>
            <div aria-live="polite">
              {isProving && (
                <div className="proof-progress">
                  <span className="progress-fingerprint">
                    <FingerprintIcon size={34} />
                  </span>
                  <div>
                    <strong>Building a proof from your private evidence</strong>
                    <p>
                      The first run downloads proving files and may take a
                      moment. Keep this page open.
                    </p>
                    <div className="progress-track">
                      <span />
                    </div>
                  </div>
                </div>
              )}
              {proofState === "failed" && (
                <div className="proof-error" role="alert">
                  <WarningCircleIcon size={22} />
                  <div>
                    <strong>We couldn’t create this proof.</strong>
                    <p>Check your connection and try again.</p>
                    <details>
                      <summary>Technical details</summary>
                      <p>{proofError}</p>
                    </details>
                  </div>
                </div>
              )}
              {isVerified && (
                <div className="verified-message">
                  <span className="verified-seal">
                    <ShieldCheckIcon size={32} />
                  </span>
                  <div>
                    <strong>Insurance requirements satisfied</strong>
                    <p>
                      At least {money(aggregate)} aggregate and{" "}
                      {money(occurrence)} per occurrence, with the requested
                      endorsements and coverage date. Exact limits remain
                      hidden.
                    </p>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={downloadReceipt}
                  >
                    Download receipt
                    <ArrowDownIcon size={16} />
                  </button>
                </div>
              )}
            </div>
            <div className="disclosure-grid">
              <div>
                <span className="disclosure-label">
                  <CheckCircleIcon size={16} />
                  WHAT THE BUYER CAN VERIFY
                </span>
                <p>Required insurance limits are met</p>
                <p>Required endorsements are present</p>
                <p>Coverage meets the requested date</p>
              </div>
              <div>
                <span className="disclosure-label private-label">
                  <LockKeyIcon size={16} />
                  WHAT STAYS PRIVATE
                </span>
                <p>Exact aggregate and occurrence limits</p>
                <p>Original documents and report contents</p>
                <p>The selected signer within the accepted set</p>
              </div>
            </div>
            {isVerified && (
              <details className="receipt-details">
                <summary>
                  Inspect verification receipt
                  <span>
                    Proof & commitment details{" "}
                    <span aria-hidden="true">↗</span>
                  </span>
                </summary>
                <div className="hash-grid">
                  <HashRow label="Circuit" value={proof.circuitIdentifier} />
                  <HashRow
                    label="Proof commitment"
                    value={proof.proofCommitment}
                  />
                  <HashRow label="Evidence root" value={receipt.evidenceRoot} />
                  <HashRow
                    label="Request-scoped identifier"
                    value={receipt.subjectNullifier ?? "—"}
                  />
                  <HashRow label="Receipt ID" value={receipt.id} />
                  <HashRow
                    label="Policy commitment"
                    value={receipt.policyCommitment}
                  />
                </div>
                <p>
                  Prepared locally. No transaction has been submitted on-chain.
                </p>
              </details>
            )}
            <div className="scope-note">
              <span>PROOF SCOPE</span>
              <p>
                Insurance uses a real zero-knowledge proof. SOC 2 and ISO 9001
                are evaluated locally; they are not included in the
                cryptographic proof.
              </p>
            </div>
          </section>

          <section id="how-it-works" className="how-it-works">
            <div className="eyebrow">LESS SHARED. MORE CERTAIN.</div>
            <h2>Evidence stays put. Trust moves forward.</h2>
            <div className="steps-grid">
              <div>
                <span>01</span>
                <h3>Hold your evidence</h3>
                <p>
                  Signed records stay in the supplier’s private wallet, with
                  their issuer and scope intact.
                </p>
              </div>
              <div>
                <span>02</span>
                <h3>Match the requirement</h3>
                <p>
                  The buyer sets a policy. The local planner checks current,
                  authorized evidence.
                </p>
              </div>
              <div>
                <span>03</span>
                <h3>Prove just enough</h3>
                <p>
                  A cryptographic proof confirms the insurance requirements
                  without revealing exact limits.
                </p>
              </div>
            </div>
          </section>
          <footer className="footer">
            <span className="footer-brand">attest.</span>
            <p>
              Research demo · Synthetic evidence · POD/GPC is beta and unaudited
            </p>
            <a
              href="https://github.com/gmackie/attest/tree/feat/assurance-kernel-poc/specs"
              target="_blank"
              rel="noreferrer"
            >
              Protocol & limitations
              <ArrowSquareOutIcon size={13} />
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}

function EvidenceCard({
  kind,
  title,
  issuer,
  icon: Icon,
  reveal,
  rows,
}: {
  kind: string;
  title: string;
  issuer: string;
  icon: typeof ShieldCheckIcon;
  reveal: boolean;
  rows: readonly (readonly [string, string])[];
}) {
  return (
    <article className={`evidence-card ${kind}`}>
      <div className="evidence-card-header">
        <span className="document-icon">
          <Icon size={23} />
        </span>
        <div>
          <h3>{title}</h3>
          <p>{issuer}</p>
        </div>
        <span className="record-status">
          <span />
          Active
        </span>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {reveal ? (
                <span className="revealed-value">{value}</span>
              ) : (
                <span className="redacted" role="img" aria-label="Hidden value">
                  <span />
                  <LockKeyIcon size={11} />
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="record-footer">
        <span className="record-lines" aria-hidden="true">
          ▤
        </span>
        <span>
          {kind === "insurance"
            ? "Signed insurance credential"
            : kind === "audit"
              ? "Private examination report"
              : "Private certification record"}
        </span>
        <LockKeyIcon size={12} />
      </div>
    </article>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hash-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}
