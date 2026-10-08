import { useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Collapsible, LayerCard } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  KeyIcon,
  LockKeyIcon,
  SignatureIcon,
  WalletIcon,
} from "@phosphor-icons/react";
import {
  authenticateRecord,
  institution,
  supplierCoverage,
  type DemoRun,
} from "@attest/demo";

const short = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 36
    ? `${text.slice(0, 20)}…${text.slice(-10)}`
    : text;
};
const money = (value: number) => `$${(value / 1_000_000).toLocaleString()}M`;
function Tile({
  title,
  children,
  privateData = false,
}: {
  title: string;
  children: ReactNode;
  privateData?: boolean;
}) {
  return (
    <LayerCard className="crypto-tile">
      <div className="crypto-tile-title">
        {privateData ? <LockKeyIcon /> : <KeyIcon />}
        <strong>{title}</strong>
        <Badge variant={privateData ? "secondary" : "outline"}>
          {privateData ? "Private" : "Public"}
        </Badge>
      </div>
      {children}
    </LayerCard>
  );
}
function Token({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="crypto-token">
      <span>{label}</span>
      <code>{short(value) || "Created when this step runs"}</code>
    </div>
  );
}
function Connector({ children }: { children: ReactNode }) {
  return (
    <div className="crypto-connector">
      <ArrowDownIcon />
      <span>{children}</span>
    </div>
  );
}
export function CryptoExplainer({ step, run }: { step: number; run: DemoRun }) {
  const [issuerIndex, setIssuerIndex] = useState(0);
  const [anchored, setAnchored] = useState(false);
  const [tampered, setTampered] = useState(false);
  const [openRecord, setOpenRecord] = useState<number | null>(null);
  const roles = ["insurer", "auditor", "certifier"] as const;
  const issuer = institution(run.config[roles[issuerIndex]!]);
  const record = run.records?.[issuerIndex];
  const checkedRecord = useMemo(
    () =>
      record &&
      (tampered
        ? {
            ...record,
            attestation: {
              ...record.attestation,
              subject: "supplier:changed-after-signing",
            },
          }
        : record),
    [record, tampered],
  );
  const signatureValid = useMemo(
    () => (checkedRecord ? authenticateRecord(checkedRecord) : undefined),
    [checkedRecord],
  );
  const coverage = supplierCoverage[run.config.supplier]!;
  const completed = run.completed > step;
  const issuerPicker = (
    <div className="controls crypto-picker">
      {roles.map((role, index) => (
        <Button
          key={role}
          size="sm"
          variant={issuerIndex === index ? "secondary" : "ghost"}
          onClick={() => {
            setIssuerIndex(index);
            setTampered(false);
          }}
        >
          {institution(run.config[role]).short} · {role}
        </Button>
      ))}
    </div>
  );
  const signedEnvelope = (
    <>
      <Token
        label="Record belongs to"
        value={checkedRecord?.attestation.subject ?? run.config.supplier}
      />
      <Token
        label="Issuer public key"
        value={record?.signedPod.signerPublicKey}
      />
      <div className="signature-seal">
        <SignatureIcon size={25} />
        <div>
          <strong>{issuer.short} · digital signature</strong>
          <code>
            {short(record?.signedPod.signature) ||
              "Waiting for issuer signature"}
          </code>
        </div>
      </div>
      <p>
        A signature is a mathematical seal over the record. It is not a picture
        of someone’s handwriting.
      </p>
    </>
  );
  return (
    <section
      className="crypto-explainer"
      aria-label="Crypto explained visually"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">UNDER THE HOOD</span>
          <h4>
            {
              [
                "A one-use request ticket",
                "An issuer signs an envelope",
                "Check the seal, then the authority",
                "Inside the supplier’s wallet",
                "Choose evidence, keep its boundaries",
                "Private inputs → public proof",
                "What the buyer can actually check",
              ][step]
            }
          </h4>
        </div>
        <Badge variant="secondary">
          {completed ? "Actual run" : "Step preview"}
        </Badge>
      </div>
      <p className="crypto-legend">
        Fictional people and institutions; real demo cryptography. Key labels
        and envelope drawings are teaching aids. Shortened fingerprints below
        come from this run when available.
      </p>
      {step === 0 && (
        <>
          <Tile title="Buyer’s request ticket">
            <Token label="To this supplier" value={run.config.supplier} />
            <Token
              label="Aggregate / occurrence"
              value={`${money(run.config.scenario === "insufficient" ? 20_000_000 : run.config.aggregate)} / ${money(run.config.occurrence)}`}
            />
            <Token
              label="One-use challenge"
              value={run.requirement?.challenge}
            />
          </Tile>
          <Connector>Bind the proof to this exact ticket</Connector>
          <div className="crypto-equation">
            Same credential + different challenge = a different proof request
          </div>
          <p>
            The challenge is a fresh identifier, not a password. Later, the
            verifier rejects a proof made for another ticket. Reset creates a
            new ticket.
          </p>
        </>
      )}
      {step === 1 && (
        <>
          {issuerPicker}
          <Tile title={`${issuer.short} signing key`} privateData>
            <div className="toy-key">
              <KeyIcon size={28} />
              <strong>SECRET KEY · {issuer.short}</strong>
            </div>
            <p>
              Only this issuer uses its signing key. Each demo issuer has a
              different key. These sandbox keys are public in the source code.
            </p>
          </Tile>
          <Connector>
            Sign the exact record with the issuer’s secret key
          </Connector>
          <Tile title={`${issuer.name} credential`} privateData>
            {signedEnvelope}
          </Tile>
          <div className="crypto-equation">
            Sign(secret key, record) → signature
            <br />
            Verify(public key, record, signature) → valid or invalid
          </div>
        </>
      )}
      {step === 2 && (
        <>
          {issuerPicker}
          <Tile title="Signature check" privateData>
            {signedEnvelope}
            <div className="controls">
              <Button
                size="sm"
                disabled={!record}
                variant="secondary"
                onClick={() => setTampered((v) => !v)}
              >
                {tampered
                  ? "Restore original record"
                  : "Change the signed subject"}
              </Button>
              {record && (
                <Badge variant={signatureValid ? "success" : "error"}>
                  {signatureValid
                    ? "Signature matches"
                    : "Signature does not match"}
                </Badge>
              )}
            </div>
            <p>
              This experiment changes a copy of the record, keeps its original
              signature, and runs the real signature check. It does not alter
              your walkthrough.
            </p>
          </Tile>
          <Connector>
            A matching signature proves who signed, not who is trusted
          </Connector>
          <Tile title="Authority check">
            <div className="trust-chain">
              {issuerIndex === 0
                ? "Insurance Trust Council"
                : issuerIndex === 1
                  ? "Audit Standards Board"
                  : "Quality Accreditation Council → Meridian Accreditation"}
              <ArrowDownIcon />
              <strong>{issuer.name}</strong>
            </div>
            <p>
              {run.config.scenario === "untrusted" && issuerIndex === 0
                ? "This scenario removes the insurer’s grant. Its genuine signature is still insufficient."
                : `The buyer accepts this issuer only within its ${roles[issuerIndex]} scope. Grants are local demo fixtures, not cryptographic certificates.`}
            </p>
          </Tile>
        </>
      )}
      {step === 3 && (
        <>
          <Tile
            title={`${institution(run.config.supplier).short} · compliance wallet`}
            privateData
          >
            <div className="wallet-identity">
              <WalletIcon size={32} />
              <div>
                <strong>{institution(run.config.supplier).name}</strong>
                <p>Holder identity + credentials + sharing rules</p>
              </div>
            </div>
            <p>
              The wallet is a container in browser memory, not a bank account.
              The insurance POD is bound to this holder’s public key; the
              holder’s secret stays inside the proving process.
            </p>
            <Token
              label="Insurance holder public key"
              value={run.insurancePod?.content.getValue("owner")?.value}
            />
            <div className="wallet-slots">
              {roles.map((role, index) => (
                <LayerCard className="wallet-slot" key={role}>
                  <div>
                    <SignatureIcon />
                    <strong>{["Insurance", "SOC 2", "ISO 9001"][index]}</strong>
                    <Badge variant="outline">
                      {run.wallet ? "Stored" : "Not stored yet"}
                    </Badge>
                  </div>
                  <p>{institution(run.config[role]).name}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!run.wallet}
                    onClick={() =>
                      setOpenRecord(openRecord === index ? null : index)
                    }
                  >
                    {openRecord === index
                      ? "Hide private contents"
                      : "Open credential"}
                  </Button>
                  {openRecord === index && (
                    <div className="wallet-record">
                      <Token
                        label="Subject"
                        value={run.records?.[index]?.attestation.subject}
                      />
                      <Token
                        label="Signature"
                        value={run.records?.[index]?.signedPod.signature}
                      />
                      <pre>
                        {JSON.stringify(
                          run.records?.[index]?.attestation.claims,
                          (_, v: unknown) =>
                            typeof v === "bigint" ? v.toString() : v,
                          2,
                        )}
                      </pre>
                    </div>
                  )}
                </LayerCard>
              ))}
            </div>
          </Tile>
          <p>
            Opening a card reveals demo data to you, the learner. It does not
            send that data to the buyer.
          </p>
        </>
      )}
      {step === 4 && (
        <>
          <Tile title="Supplier’s private evidence" privateData>
            <div className="crypto-comparison">
              <span>
                Insurance holds
                <strong>
                  {money(coverage[0])} / {money(coverage[1])}
                </strong>
              </span>
              <span>
                Buyer requires
                <strong>
                  {money(
                    run.config.scenario === "insufficient"
                      ? 20_000_000
                      : run.config.aggregate,
                  )}{" "}
                  / {money(run.config.occurrence)}
                </strong>
              </span>
            </div>
            <p>
              The planner checks amounts together with the subject, dates,
              status and authority. Sufficient numbers alone do not make a
              credential acceptable.
            </p>
          </Tile>
          <Connector>Select three coherent records inside the wallet</Connector>
          <div className="witness-cards">
            {["Insurance", "SOC 2", "ISO 9001"].map((name) => (
              <Badge variant="outline" key={name}>
                {name} · one record
              </Badge>
            ))}
          </div>
          <div className="merkle-explainer">
            <div className="witness-cards">
              <code>hash(insurance record)</code>
              <code>hash(SOC 2 record)</code>
              <code>hash(ISO record)</code>
            </div>
            <Connector>Combine hashes in a Merkle tree</Connector>
            <div className="crypto-equation">
              One evidence root commits to the selected set
            </div>
            <p>
              The receipt computes this root after verification. A Merkle
              inclusion witness would be a path of sibling hashes showing one
              record belongs to that root. This demo does not create or verify a
              Merkle inclusion proof; its insurance ZK proof does not bind this
              cross-domain root.
            </p>
          </div>
          <p>
            Each domain’s facts must come from one record. The planner cannot
            borrow a high limit from one supplier and a valid date from another.
            This is a local decision, not yet a proof.
          </p>
        </>
      )}
      {step === 5 && (
        <>
          <Tile title="Prover’s private inputs" privateData>
            <div className="witness-cards">
              <Badge variant="secondary">Signed insurance POD</Badge>
              <Badge variant="secondary">Exact insurance limits</Badge>
              <Badge variant="secondary">Holder secret</Badge>
            </div>
            <p>
              The signature authenticates the insurance facts. The holder secret
              demonstrates control of the identity bound to the insurance
              credential.
            </p>
          </Tile>
          <Connector>
            Real POD / GPC computation · no secret key is sent
          </Connector>
          <Tile title="Proof package for the buyer">
            <Token
              label="Proof commitment"
              value={run.proof?.proofCommitment}
            />
            <Token
              label="Request challenge"
              value={run.requirement?.challenge}
            />
            <p>
              Public: thresholds, subject binding, accepted issuer set,
              challenge and proof. Hidden: exact limits, selected issuer, holder
              secret.
            </p>
          </Tile>
          <div className="crypto-equation">
            “I meet these insurance requirements”
            <br />
            without revealing the exact insured amounts
          </div>
          <p>SOC 2 and ISO 9001 are not inside this proof.</p>
          <LayerCard className="crypto-tile">
            <strong className="crypto-subtitle">What is a witness?</strong>
            <p>
              In the planner, a witness is a selected credential supporting a
              requirement. In the proving system, the private witness includes
              hidden credential values, signature data, and the holder secret
              used to satisfy the circuit.
            </p>
            <div className="witness-circuit">
              <div>
                <Badge variant="secondary">Private witness</Badge>
                <span>Insurance values + signature + holder secret</span>
              </div>
              <span className="circuit-arrow">→</span>
              <div>
                <Badge variant="outline">Circuit checks</Badge>
                <span>Valid signature · correct holder · limits ≥ request</span>
              </div>
              <span className="circuit-arrow">→</span>
              <div>
                <Badge variant="success">Proof</Badge>
                <span>
                  A verifiable mathematical result, not a copy of the witness
                </span>
              </div>
            </div>
            <p>
              The buyer combines this proof with public inputs. The proof cannot
              be “decrypted” into the original policy document.
            </p>
          </LayerCard>
        </>
      )}
      {step === 6 && (
        <>
          <Tile title="Buyer’s verification desk">
            <Token
              label="Original request"
              value={run.requirement?.challenge}
            />
            <Token
              label="Received proof commitment"
              value={run.proof?.proofCommitment}
            />
            <div className="verification-checks">
              <Badge variant={run.receipt ? "success" : "outline"}>
                {run.receipt
                  ? "Proof verified against original request"
                  : "Awaiting independent verification"}
              </Badge>
            </div>
            <p>
              The verifier checks the proof using public verification material
              and the original request. It never needs an issuer’s signing
              secret or the holder’s secret.
            </p>
          </Tile>
          <Connector>Successful verification → local receipt</Connector>
          <Tile title="Receipt">
            <Token
              label="Proof commitment"
              value={run.receipt?.proofCommitment}
            />
            <Token
              label="Local evidence root"
              value={run.receipt?.evidenceRoot}
            />
            <p>
              A commitment is a fingerprint, not encrypted evidence. The
              evidence root is local metadata; the insurance proof does not
              establish it. Nothing is published on-chain.
            </p>
          </Tile>
          <LayerCard className="crypto-tile chain-demo">
            <div className="section-heading">
              <strong>Blockchain storage explorer</strong>
              <Badge variant="outline">Simulation only</Badge>
            </div>
            <p>
              A blockchain is a shared ledger of transactions, contract state
              and event logs. Here is how this repository’s AssuranceAnchor
              contract would record commitments.
            </p>
            <div className="storage-columns">
              <div>
                <h5>Stays off-chain</h5>
                <ul>
                  <li>Raw documents and exact limits</li>
                  <li>Signed credentials and holder secret</li>
                  <li>Private proving witness</li>
                  <li>Proof package (this contract logs its commitment)</li>
                </ul>
              </div>
              <div>
                <h5>Public on-chain</h5>
                <ul>
                  <li>Issuer address and credential commitments</li>
                  <li>Schema hash, expiry and status</li>
                  <li>Receipt commitments and subject nullifier</li>
                  <li>Verification claim and caller address</li>
                </ul>
              </div>
            </div>
            <Collapsible.Root>
              <Collapsible.Trigger
                render={<Button size="sm" variant="ghost" />}
              >
                Inspect contract storage vs event logs
              </Collapsible.Trigger>
              <Collapsible.Panel>
                <div className="chain-schema">
                  <strong>anchors[attestationId] → contract state</strong>
                  <code>
                    issuer · evidenceCommitment · schemaHash · validUntil ·
                    status
                  </code>
                  <p>
                    anchorAttestation writes this mapping. Only the original
                    issuer can change that anchor’s status.
                  </p>
                  <strong>VerificationRecorded → event log</strong>
                  <code>
                    receiptId · policyCommitment · evidenceRoot ·
                    proofCommitment · subjectNullifier · satisfied · verifier
                  </code>
                  <p>
                    recordVerification emits an event. It does not store a
                    receipt mapping or run the GPC verifier. The caller supplies
                    the result; observers must decide which callers they trust.
                  </p>
                </div>
              </Collapsible.Panel>
            </Collapsible.Root>
            <Button
              variant="secondary"
              disabled={!run.receipt || anchored}
              onClick={() => setAnchored(true)}
            >
              {anchored
                ? "Included in simulated block"
                : "Simulate receipt inclusion in a block"}
            </Button>
            {!run.receipt && (
              <p>
                Finish independent verification to populate this example with
                your receipt.
              </p>
            )}
            {anchored && (
              <div className="simulated-block">
                <div className="block-link">
                  Previous block fingerprint → illustrative next block
                </div>
                <div className="section-heading">
                  <strong>Example block · local visualization</strong>
                  <Badge variant="secondary">No transaction sent</Badge>
                </div>
                <div className="chain-schema">
                  <strong>Transaction: recordVerification(...)</strong>
                  <Token
                    label="policyCommitment · fingerprint of request"
                    value={run.receipt?.policyCommitment}
                  />
                  <Token
                    label="evidenceRoot · combined local evidence fingerprint"
                    value={run.receipt?.evidenceRoot}
                  />
                  <Token
                    label="proofCommitment · fingerprint of proof transcript"
                    value={run.receipt?.proofCommitment}
                  />
                  <Token
                    label="subjectNullifier · request-scoped holder-derived commitment"
                    value={run.receipt?.subjectNullifier}
                  />
                  <Token
                    label="satisfied · caller-supplied claim"
                    value={String(run.receipt?.satisfied)}
                  />
                  <p>
                    The contract would generate its own receiptId using the
                    chain, contract, sender, block number and these fields. The
                    local receipt ID is not that on-chain ID.
                  </p>
                </div>
              </div>
            )}
            <p>
              Consensus would order and preserve the transaction. It would not
              establish that the source document is true. This contract records
              a caller’s verification claim; it does not independently verify
              the private proof.
            </p>
          </LayerCard>
          <p>
            Use Test replay rejection below to try the same proof against a
            changed challenge. The real verifier should reject it.
          </p>
        </>
      )}
      <Collapsible.Root>
        <Collapsible.Trigger render={<Button variant="ghost" size="sm" />}>
          Key, signature, wallet, proof: what’s the difference?
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <dl className="crypto-glossary">
            <dt>Secret key</dt>
            <dd>
              Used to sign or demonstrate ownership. It should not be shared in
              a real system.
            </dd>
            <dt>Public key</dt>
            <dd>
              Lets others check a signature or bind a credential to its holder.
            </dd>
            <dt>Signature</dt>
            <dd>
              Connects the exact signed data to its issuer. It does not hide
              that data.
            </dd>
            <dt>Wallet</dt>
            <dd>
              Stores credentials and controls which private inputs a
              presentation uses.
            </dd>
            <dt>Zero-knowledge proof</dt>
            <dd>
              Lets the buyer verify a specific statement without receiving the
              hidden inputs.
            </dd>
          </dl>
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );
}
