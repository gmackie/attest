import { useState } from "react";
import { Badge, Button, LayerCard, LinkButton } from "@cloudflare/kumo";

const transactionSteps = [
  {
    title: "Prepare the call",
    actor: "Institution application",
    action:
      "Choose a chain and deployed contract address, then ABI-encode the function and arguments. For anchorAttestation, those arguments are an attestation ID, evidence commitment, schema hash, and expiry.",
    boundary:
      "A commitment is a fingerprint of evidence. It neither uploads the evidence nor guarantees that someone will keep it available.",
    artifact:
      "anchorAttestation(id, evidenceCommitment, schemaHash, validUntil)",
  },
  {
    title: "Authorize & pay",
    actor: "Transaction wallet",
    action:
      "The wallet signs a transaction binding the destination, calldata, nonce, chain ID, and fee settings. An ordinary sending account pays gas in the chain’s native currency. A relayer could sponsor a transaction in a separately designed flow.",
    boundary:
      "The credential’s POD signing key and the EVM transaction key are different keys with different roles. A wallet signature authorizes a transaction; it does not establish an institution’s authority to issue a license.",
    artifact:
      "transaction = { to, data, nonce, chainId, gasLimit, fees } + signature",
  },
  {
    title: "Submit to an RPC",
    actor: "Node / RPC provider",
    action:
      "The application sends the signed transaction to a node. Depending on the network it enters a transaction pool or sequencer pipeline. Fees, an invalid nonce, or insufficient funds can prevent inclusion.",
    boundary:
      "An RPC acknowledgment is not confirmation. The RPC transports and serves chain data; it is not the credential issuer or accreditation authority.",
    artifact: "signed transaction → RPC → pending transaction hash",
  },
  {
    title: "Execute bytecode",
    actor: "Ethereum Virtual Machine",
    action:
      "The EVM is the deterministic execution engine used by Ethereum and compatible networks. Nodes execute contract bytecode against chain state, metering instructions with gas. This call writes an Anchor and emits an event. A revert rolls back this transaction’s state changes and logs, but still consumes gas.",
    boundary:
      "Contracts cannot directly fetch an insurer API or hospital database. An external assertion needs a submitted proof or a trusted attestation, with explicit rules for checking it.",
    artifact:
      "anchors[id] = { issuer: msg.sender, commitments, expiry, status: Active }",
  },
  {
    title: "Wait for finality",
    actor: "Network consensus",
    action:
      "Inclusion produces a transaction receipt with execution status, gas used, and logs. The application waits according to its finality policy because recent blocks may be reorganized. On an L2, sequencer inclusion and settlement on L1 are distinct milestones.",
    boundary:
      "There is no universal fee or confirmation time across EVM networks. A successful receipt means the code ran successfully, not that the underlying claim is true.",
    artifact: "pending → included → required finality reached",
  },
  {
    title: "Read & interpret",
    actor: "Buyer / independent verifier",
    action:
      "Read current anchor state and index relevant events. Independently check issuer authority, credential signatures, subject binding, proof inputs, policy, validity, and sufficiently fresh status before accepting a presentation.",
    boundary:
      "eth_call reads or simulates without sending a paid transaction; an RPC provider may charge for service. Contracts can read accessible contract state, but cannot directly query historical event logs.",
    artifact: "chain record + verified presentation + trust policy → decision",
  },
];
const models = [
  {
    title: "Direct federation",
    path: ["Issuer", "Holder wallet", "Buyer verifier"],
    role: "Each buyer integrates with issuers and verifies holder presentations itself. A central clearinghouse is optional.",
    sees: "Issuers retain source records. The buyer receives the requested proofs and public inputs, or explicitly disclosed fields.",
    trust:
      "The buyer selects trusted issuer keys and scopes, and owns verification and status policy.",
    tradeoff:
      "Few intermediaries, but repeated onboarding and schema integration for every buyer.",
    outage:
      "Issuer status outages require fresh alternate evidence or a pending decision under the buyer’s policy.",
  },
  {
    title: "Registry clearinghouse",
    path: ["Issuer onboarding", "Directory & status", "Independent buyer"],
    role: "A shared directory publishes approved keys, issuer scopes, schema versions, and status endpoints. It need not collect raw credentials.",
    sees: "Institution metadata and potentially lookup traffic. Query patterns can reveal relationships even without evidence values.",
    trust:
      "Buyers trust directory governance for scoped authority and key history, while independently checking presentations.",
    tradeoff:
      "Reusable discovery and onboarding; a compromised registry can misdirect trust to the wrong key.",
    outage:
      "Signed, cached metadata is usable only within explicit freshness limits. Expired status means pending fresh evidence.",
  },
  {
    title: "Managed verification",
    path: [
      "Holder presentation",
      "Clearinghouse verifier",
      "Buyer receipt consumer",
    ],
    role: "An operator checks presentations and returns a signed, request-bound result. This can reduce integration work for smaller buyers.",
    sees: "Proofs and public inputs; disclosed data too if that mode is chosen. A private proof still exposes its public inputs.",
    trust:
      "Unless the buyer rechecks the proof and policy, it trusts the operator’s result. Recording that result on-chain does not remove this dependency.",
    tradeoff:
      "Simpler buyer integration, with concentrated availability, privacy, and policy-execution risk.",
    outage:
      "An unavailable verifier cannot produce a fresh result. Use an authorized independent verifier or keep the request pending.",
  },
  {
    title: "Consortium network",
    path: ["Member institutions", "Governed registry", "Multiple verifiers"],
    role: "Members jointly govern issuer admission, schema changes, disputes, and verifier operation. Quorum rules could apply to administrative changes.",
    sees: "Shared registry metadata. Presentation visibility depends on routing; membership need not imply access to every patient or supplier record.",
    trust:
      "Buyers rely on the consortium’s governance and chosen verifier policy. Multiple signatures do not make a false source fact true.",
    tradeoff:
      "Shared control and redundancy, with slower governance and risks from collusion or common software failures.",
    outage:
      "Define failover and membership-change rules in advance. A quorum outage must not silently weaken acceptance criteria.",
  },
];
const responsibilities = [
  [
    "Issuer onboarding",
    "Verify legal identity, scoped authority, delegation, and effective dates. Registry membership does not authorize every kind of claim.",
  ],
  [
    "Schema registry",
    "Version meanings, units, and mappings. Preserve original issuer provenance; identify derived credentials and who takes responsibility for them.",
  ],
  [
    "Routing & consent",
    "Resolve endpoints and holder authorization for a specific request. Participation is not blanket consent to collect raw evidence.",
  ],
  [
    "Status & key lifecycle",
    "Publish signed, freshness-bounded status, rotation and compromise notices. Define how historical signatures are evaluated after a key change.",
  ],
  [
    "Verification service",
    "Bind results to the subject, request, policy, circuit version, and public inputs. Distinguish an operator’s attestation from a proof the buyer independently checked.",
  ],
  [
    "Audit & disputes",
    "Define corrections, appeals, operator liability, retention, and governance. An audit trail records actions; it does not establish source truth.",
  ],
];
const scenarios = [
  {
    title: "Current, valid presentation",
    result: "Eligible under the specified policy",
    detail:
      "Assume the signature, scoped authority, subject, request, proof, policy, expiry, and fresh status checks all pass. The buyer may approve this request, with a defined re-evaluation deadline. Approval is not permanent accreditation.",
  },
  {
    title: "Revoked after issuance",
    result: "Reject or suspend",
    detail:
      "An old signature and proof may remain mathematically valid after revocation. Acceptance needs sufficiently current status. The current demo circuits do not prove live on-chain status; a production verifier needs a separate status check or a deliberately integrated status proof.",
  },
  {
    title: "Stale clearinghouse status",
    result: "Pending fresh evidence",
    detail:
      "A correctly signed status response can be too old. Check its issuer, timestamp, validity window, and the buyer’s maximum status age. Do not turn an unavailable fresh response into a positive assertion.",
  },
  {
    title: "Unknown caller writes satisfied=true",
    result: "Do not accept the event as proof",
    detail:
      "Anyone can call the current recordVerification function. The contract records the caller’s address and supplied boolean without checking a proof. A buyer must independently verify or explicitly trust an authorized attester under a separate policy.",
  },
  {
    title: "Valid proof, wrong request",
    result: "Reject the binding mismatch",
    detail:
      "A cryptographically valid proof for a different challenge, subject, policy, or audience cannot approve this request. Check public-input bindings and replay rules. The receipt contract itself does not enforce nullifier uniqueness.",
  },
  {
    title: "Directory unavailable",
    result: "Use an explicit fallback or wait",
    detail:
      "An approved cache or alternate directory may work while its signatures and freshness bounds remain valid. If no permitted source meets those requirements, the request stays pending. Availability problems must not become automatic approvals.",
  },
];

export function InfrastructureExplorer() {
  const [tab, setTab] = useState(0);
  const [step, setStep] = useState(0);
  const [model, setModel] = useState(1);
  const [scenario, setScenario] = useState(0);
  const transaction = transactionSteps[step]!;
  const clearinghouse = models[model]!;
  const decision = scenarios[scenario]!;
  return (
    <section id="infrastructure" className="infrastructure-explorer">
      <div className="section-heading">
        <div>
          <span className="eyebrow">BEYOND THE BROWSER DEMO</span>
          <h2>
            Where the EVM ends.
            <br />
            Where institutional trust begins.
          </h2>
        </div>
        <Badge variant="outline">Architecture explorer</Badge>
      </div>
      <p className="infra-intro">
        Follow a transaction into shared chain state, then explore who could
        connect institutions, resolve trusted issuers, and check private
        presentations.
      </p>
      <p>
        The running demo uses local browser flows and simulated ledger receipts.
        This explorer explains the reference Solidity contract and proposed
        infrastructure; it does not submit transactions or contact a
        clearinghouse.
      </p>
      <div className="controls infra-tabs" aria-label="Infrastructure topics">
        {[
          "EVM & chain storage",
          "Credential clearinghouses",
          "Decision scenarios",
        ].map((label, i) => (
          <Button
            key={label}
            variant={tab === i ? "primary" : "secondary"}
            aria-pressed={tab === i}
            onClick={() => setTab(i)}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === 0 && (
        <div className="infra-content">
          <h3>A transaction, from an institution to shared state</h3>
          <div className="infra-steps" aria-label="Transaction stages">
            {transactionSteps.map((item, i) => (
              <Button
                key={item.title}
                variant={step === i ? "primary" : "secondary"}
                aria-pressed={step === i}
                onClick={() => setStep(i)}
              >
                {i + 1}. {item.title}
              </Button>
            ))}
          </div>
          <LayerCard className="infra-detail" key={step}>
            <Badge variant="outline">
              Step {step + 1} of 6 · {transaction.actor}
            </Badge>
            <h3>{transaction.title}</h3>
            <p>{transaction.action}</p>
            <pre>{transaction.artifact}</pre>
            <p className="infra-boundary">{transaction.boundary}</p>
            <div className="controls">
              <Button
                variant="secondary"
                disabled={step === 0}
                onClick={() => setStep(step - 1)}
              >
                Previous step
              </Button>
              <Button disabled={step === 5} onClick={() => setStep(step + 1)}>
                Next step
              </Button>
            </div>
          </LayerCard>
          <div className="infra-grid">
            <LayerCard className="infra-card">
              <Badge variant="outline">Shared state</Badge>
              <h3>Contract storage</h3>
              <p>
                The anchors mapping stores issuer address, evidence commitment,
                schema hash, validUntil, and status under an attestation ID.
                Other contracts can read this state.
              </p>
              <p>
                Expiry is a stored value. The current contract does not
                automatically reject expired evidence.
              </p>
            </LayerCard>
            <LayerCard className="infra-card">
              <Badge variant="outline">Public history</Badge>
              <h3>Calldata & event logs</h3>
              <p>
                Transaction arguments and emitted logs are public.
                VerificationRecorded is an event, not a stored receipt mapping.
                Indexers can retrieve it; contracts cannot directly query past
                logs.
              </p>
              <p>
                The receipt ID binds chain, contract, caller, supplied
                commitments, nullifier, result, and block number. The browser’s
                simulated receipt uses a different construction.
              </p>
            </LayerCard>
            <LayerCard className="infra-card">
              <Badge variant="outline">Off-chain custody</Badge>
              <h3>Evidence & private witnesses</h3>
              <p>
                Institutions retain source records; holders retain credentials
                and secrets. A witness is private input to proof generation,
                including hidden signed fields and required secrets. A verifier
                receives a proof and its public inputs.
              </p>
              <p>
                Never submit raw evidence or secret witnesses as calldata. A
                commitment cannot recover missing documents. The demo’s logical
                stores live in browser memory, without server isolation or
                persistence.
              </p>
            </LayerCard>
          </div>
          <div className="infra-grid infra-two">
            <LayerCard className="infra-card">
              <h3>What this contract enforces</h3>
              <ul>
                <li>An attestation ID can only be anchored once.</li>
                <li>The recorded issuer is the calling address.</li>
                <li>
                  Only that original issuer can change its anchor’s status.
                </li>
                <li>
                  Status changes emit events. Revocation is not irreversible:
                  the issuer can set Active again.
                </li>
              </ul>
            </LayerCard>
            <LayerCard className="infra-card">
              <h3>What it does not enforce</h3>
              <ul>
                <li>Issuer accreditation or an authorized verifier list.</li>
                <li>
                  Proof verification: recordVerification accepts no proof.
                </li>
                <li>
                  Expiry, current status, or links from the supplied evidence
                  root to anchors.
                </li>
                <li>
                  Replay prevention or uniqueness of the supplied nullifier.
                </li>
              </ul>
              <p>
                Anyone can record satisfied=true. The event is a caller’s
                assertion, not a contract-verified conclusion.
              </p>
            </LayerCard>
            <LayerCard className="infra-card">
              <h3>Where proof verification runs</h3>
              <p>
                Today, proof checks run off-chain in the browser. A production
                off-chain verifier could attest its result; the buyer must trust
                that verifier or recheck the proof.
              </p>
              <p>
                An on-chain verifier would need compatible verifier bytecode, a
                pinned circuit and verification key, explicit public-input
                bindings, and gas assessment. Issuer authority and fresh status
                still need their own rules.
              </p>
            </LayerCard>
            <LayerCard className="infra-card">
              <h3>Gas and privacy are design choices</h3>
              <p>
                Storage writes and on-chain proof verification consume gas.
                Reverted transactions also cost gas. Fees vary by network,
                congestion, and execution; reads through eth_call do not
                themselves submit paid transactions.
              </p>
              <p>
                Hashing is not encryption or anonymity. Predictable unsalted
                values can be guessed. Addresses, timestamps, repeated
                identifiers, and public inputs can correlate institutions and
                holders even when hidden values stay private.
              </p>
            </LayerCard>
          </div>
          <div className="controls">
            <LinkButton
              variant="secondary"
              href="https://github.com/gmackie/attest/blob/feat/assurance-kernel-poc/contracts/src/AssuranceAnchor.sol"
            >
              Read the actual contract ↗
            </LinkButton>
            <LinkButton
              variant="ghost"
              href="https://ethereum.org/en/developers/docs/evm/"
            >
              EVM reference ↗
            </LinkButton>
            <LinkButton
              variant="ghost"
              href="https://ethereum.org/en/developers/docs/gas/"
            >
              Gas reference ↗
            </LinkButton>
          </div>
        </div>
      )}
      {tab === 1 && (
        <div className="infra-content">
          <Badge variant="outline">
            Proposed models · no live clearinghouse integration
          </Badge>
          <h3>
            A clearinghouse connects institutions. Its powers must be explicit.
          </h3>
          <p>
            Here, a credential clearinghouse means an optional coordination
            service for discovery, trust metadata, routing, status, or
            verification. It need not issue credentials, hold raw records, or
            run a blockchain. These responsibilities can belong to separate
            operators.
          </p>
          <div className="controls" aria-label="Clearinghouse models">
            {models.map((item, i) => (
              <Button
                key={item.title}
                variant={model === i ? "primary" : "secondary"}
                aria-pressed={model === i}
                onClick={() => setModel(i)}
              >
                {item.title}
              </Button>
            ))}
          </div>
          <LayerCard className="infra-detail" key={model}>
            <h3>{clearinghouse.title}</h3>
            <ol className="infra-route">
              {clearinghouse.path.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
            <p>{clearinghouse.role}</p>
            <dl className="infra-facts">
              <div>
                <dt>Information it sees</dt>
                <dd>{clearinghouse.sees}</dd>
              </div>
              <div>
                <dt>Trust dependency</dt>
                <dd>{clearinghouse.trust}</dd>
              </div>
              <div>
                <dt>Tradeoff</dt>
                <dd>{clearinghouse.tradeoff}</dd>
              </div>
              <div>
                <dt>Outage & freshness</dt>
                <dd>{clearinghouse.outage}</dd>
              </div>
            </dl>
          </LayerCard>
          <h3>Define the service contract before choosing the operator</h3>
          <div className="infra-grid infra-two">
            {responsibilities.map(([title, detail]) => (
              <LayerCard className="infra-card" key={title}>
                <h4>{title}</h4>
                <p>{detail}</p>
              </LayerCard>
            ))}
          </div>
          <LayerCard className="infra-detail">
            <Badge variant="outline">
              Fictional clinical example · proposed integration
            </Badge>
            <h3>One hospital request, several independent authorities</h3>
            <ol className="infra-example">
              <li>
                A licensing board publishes its key, jurisdiction,
                license-issuance scope, and status endpoint. A malpractice
                insurer and training body publish their own separate scopes.
              </li>
              <li>
                A hospital requests an active license in the required
                jurisdiction, sufficient coverage for the specialty, and recent
                required training, all for the same clinician and evaluation
                date.
              </li>
              <li>
                The clinician’s wallet holds each institution’s signed
                credential. Raw licensing, claims, and training records remain
                with their respective custodians.
              </li>
              <li>
                A registry resolves the approved keys, schema versions, and
                fresh status responses. It does not need the clinician’s
                underlying records to publish that directory.
              </li>
              <li>
                The wallet generates request-bound proofs. Hidden fields and
                secrets stay in its private witness; required equality values
                and other public inputs are still visible to the recipient.
              </li>
              <li>
                The hospital independently checks each source’s authority,
                signatures, proof bindings, policy, and current status. An
                insurer cannot substitute for the licensing board, even when its
                signature is valid.
              </li>
              <li>
                An optional chain receipt anchors commitments to the decision
                for later audit. It does not replace evidence retention, fresh
                status checks, or clinical governance.
              </li>
            </ol>
          </LayerCard>
          <h3>A practical starting point</h3>
          <p>
            Start with a narrowly scoped directory and status service,
            holder-controlled presentations, and independent buyer verification.
            Offer managed verification as an explicit additional trust choice.
            Define key compromise, outages, disputes, retention, and governance
            before selecting a chain or operator. Shared semantics and message
            formats enable interoperability; the chain is optional.
          </p>
        </div>
      )}
      {tab === 2 && (
        <div className="infra-content">
          <Badge variant="outline">
            Illustrative scenarios · not live verification results
          </Badge>
          <h3>Which check changes the decision?</h3>
          <p>
            Explore the expected policy response when cryptographic validity,
            institutional authority, and operational freshness disagree.
          </p>
          <div className="infra-steps">
            {scenarios.map((item, i) => (
              <Button
                key={item.title}
                variant={scenario === i ? "primary" : "secondary"}
                aria-pressed={scenario === i}
                onClick={() => setScenario(i)}
              >
                {item.title}
              </Button>
            ))}
          </div>
          <LayerCard className="infra-detail" key={scenario}>
            <span className="eyebrow">{decision.title}</span>
            <h3>{decision.result}</h3>
            <p>{decision.detail}</p>
          </LayerCard>
          <p className="infra-boundary">
            Separate questions: Is the signature valid? Is this issuer
            authorized for this scope? Is the evidence current? Is this the
            right subject and request? Does the proof establish this policy? How
            fresh is status? Who takes responsibility for the result?
          </p>
        </div>
      )}
    </section>
  );
}
