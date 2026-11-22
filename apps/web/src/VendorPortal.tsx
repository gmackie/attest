/**
 * Vendor portal: prove to access (ATTE-20). A vendor user asks to approve a payout for
 * supplier:acme; the PEP challenges for CGL insurance ≥ $2M; the user proves it privately in
 * this browser; the verifier signs a short-lived result; the PEP allows and seals the decision
 * into an RFC 6962 epoch whose inclusion proof is checked here.
 *
 * The PEP is a demo stand-in for Gatekeeper and the sign-in is a demo identity (Nathan later).
 * Service URLs are configurable so the same journey can point at real Gatekeeper.
 */
import { useRef, useState } from "react";
import { Effect } from "effect";
import {
  Badge,
  Banner,
  Button,
  Collapsible,
  InputGroup,
  LayerCard,
  LinkButton,
} from "@cloudflare/kumo";
import { CaretDownIcon } from "@phosphor-icons/react";
import { track } from "./analytics";
import {
  authorize,
  checkChallenge,
  configuredDecisionAnchor,
  DEFAULT_ENDPOINTS,
  demoSignIn,
  enroll,
  fetchReceipt,
  fetchRequirement,
  issueDemoCredential,
  newHolder,
  prove,
  submitPresentation,
  verifyAgainstChain,
  verifyReceipt,
  VENDOR_PORTAL_ACTION,
  VENDOR_PORTAL_RESOURCE,
  type AnchorCheck,
  type AuthorizeResponse,
  type ChallengeRequest,
  type Holder,
  type PortalEndpoints,
  type Presentation,
  type ProofRequest,
  type RequirementDefinition,
  type ReceiptResponse,
  type ReceiptVerification,
  type Session,
} from "../../../packages/demo/src/vendor-portal";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const short = (v: string, n = 10) => (v.length > 2 * n + 1 ? `${v.slice(0, n)}…${v.slice(-n)}` : v);
const STORAGE_KEY = "attest.vendor-portal.endpoints";
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

function initialEndpoints(): PortalEndpoints {
  const defaults: PortalEndpoints = {
    pep: env.VITE_DEMO_PEP_URL || DEFAULT_ENDPOINTS.pep,
    verifier: env.VITE_VERIFIER_URL || DEFAULT_ENDPOINTS.verifier,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<PortalEndpoints> | null;
    if (saved && typeof saved.pep === "string" && typeof saved.verifier === "string")
      return { pep: saved.pep, verifier: saved.verifier };
  } catch {
    /* per-viewer convenience only */
  }
  return defaults;
}
const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
const steps = ["Sign in", "Request access", "Prove privately", "Retry", "Receipt"] as const;

export function VendorPortal() {
  const [endpoints, setEndpoints] = useState<PortalEndpoints>(initialEndpoints);
  const [draft, setDraft] = useState<PortalEndpoints>(endpoints);
  const [session, setSession] = useState<Session | null>(null);
  const [challenge, setChallenge] = useState<{ response: AuthorizeResponse; request: ChallengeRequest; proofRequest: ProofRequest } | null>(null);
  const [requirement, setRequirement] = useState<{ definition: RequirementDefinition; notice: string } | null>(null);
  const [holder, setHolder] = useState<Holder | null>(null);
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [result, setResult] = useState<{ token: string; expiresAt: number } | null>(null);
  const [decision, setDecision] = useState<AuthorizeResponse | null>(null);
  const [receipt, setReceipt] = useState<ReceiptResponse | null>(null);
  const [verification, setVerification] = useState<ReceiptVerification | null>(null);
  const [anchor, setAnchor] = useState<AnchorCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);

  const step = receipt ? 4 : decision?.outcome === "allow" ? 4 : result ? 3 : challenge ? 2 : session ? 1 : 0;

  const reset = () => {
    generation.current++;
    lock.current = false;
    setBusy(false);
    setSession(null);
    setChallenge(null);
    setRequirement(null);
    setHolder(null);
    setPresentation(null);
    setResult(null);
    setDecision(null);
    setReceipt(null);
    setVerification(null);
    setAnchor(null);
    setMessage("");
    setError("");
  };
  const run = (label: string, action: (check: () => void) => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage(label);
    const token = generation.current;
    const check = () => {
      if (token !== generation.current) throw new Error("The journey was restarted; discarded result");
    };
    void Effect.runPromise(
      Effect.tryPromise({ try: () => action(check), catch: (e) => (e instanceof Error ? e : new Error(String(e))) }),
    )
      .catch((e: Error) => {
        if (token === generation.current) {
          setError(explain(e.message));
          setMessage("");
        }
      })
      .finally(() => {
        if (token === generation.current) {
          lock.current = false;
          setBusy(false);
        }
      });
  };

  const signIn = () =>
    run("Signing in with a demo identity…", async (check) => {
      const s = await demoSignIn(endpoints, fetcher);
      check();
      setSession(s);
      setMessage(`Signed in as ${s.subject.subject}. This demo identity proves nothing about who you are.`);
    });

  const requestAccess = () =>
    run(`Asking the policy enforcement point to ${VENDOR_PORTAL_ACTION} for ${VENDOR_PORTAL_RESOURCE}…`, async (check) => {
      const response = await authorize(endpoints, fetcher, session!);
      check();
      if (response.outcome === "allow") {
        setDecision(response);
        setMessage("Allowed: an unexpired verification result is already on file for you.");
        return;
      }
      if (response.outcome !== "challenge") throw new Error(`Decision: ${response.outcome} (${response.reason})`);
      const request = response.attest?.requests?.[0];
      if (!request) throw new Error(`The PEP could not issue a proof request (${response.attest?.error ?? "unknown"})`);
      const proofRequest = await checkChallenge(endpoints, fetcher, request, session!);
      const req = await fetchRequirement(endpoints, fetcher, proofRequest);
      check();
      setChallenge({ response, request, proofRequest });
      setRequirement(req);
      track("access_challenged", { surface: "vendor-portal" });
      setMessage("Challenged: the policy needs proof of CGL coverage for supplier:acme. The signed request checks out.");
    });

  const proveAndPresent = () =>
    run("Enrolling your holder key with the verifier…", async (check) => {
      const h = holder ?? newHolder();
      setHolder(h);
      await enroll(endpoints, fetcher, session!, h);
      check();
      setMessage("Generating the private proof in this browser (about 10–30 seconds)…");
      const credential = issueDemoCredential(requirement!.definition, h);
      const p = await prove(challenge!.proofRequest, requirement!.definition, credential, h);
      check();
      setPresentation(p);
      track("proofs_generated", { surface: "vendor-portal" });
      setMessage("Sending the presentation to the verifier…");
      const r = await submitPresentation(endpoints, fetcher, challenge!.request, p);
      check();
      setResult({ token: r.result, expiresAt: r.expiresAt });
      setMessage(`The verifier signed a result valid until ${new Date(r.expiresAt).toLocaleTimeString()}. Retry the request with it.`);
    });

  const retry = () =>
    run("Retrying with the verification result…", async (check) => {
      const response = await authorize(endpoints, fetcher, session!, { requestId: challenge!.request.requestId, result: result!.token });
      check();
      if (response.outcome !== "allow") throw new Error(`Decision: ${response.outcome} (${response.reason})`);
      setDecision(response);
      track("access_allowed", { surface: "vendor-portal" });
      setMessage("Allowed. The decision was appended to the PEP's hash-chained decision log.");
    });

  const loadReceipt = () =>
    run("Sealing the epoch and fetching your decision receipt…", async (check) => {
      const r = await fetchReceipt(endpoints, fetcher, session!, decision!.decisionId);
      check();
      setReceipt(r);
      const v = await verifyReceipt(r.receipt, decision!.decisionId);
      check();
      setVerification(v);
      if (!v.local.ok || !v.matchesDecision) throw new Error("The receipt did not verify in this browser.");
      setMessage("Checking the epoch root against the on-chain DecisionLogAnchor…");
      let a: AnchorCheck;
      try {
        a = await verifyAgainstChain(r.receipt, r.ledger.logId, decision!.decisionId);
      } catch (e) {
        throw new Error(`Receipt verified locally, but the chain read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      check();
      setAnchor(a);
      track("receipt_verified", { surface: "vendor-portal", anchored: a.status === "anchored" });
      track("demo_completed", { surface: "vendor-portal" });
      setMessage(a.status === "anchored" && a.check.ok
        ? "Receipt verified against the root anchored on Sepolia."
        : "Receipt verified in this browser against the sealed epoch root.");
    });

  const saveEndpoints = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      /* per-viewer convenience only */
    }
    setEndpoints(draft);
    reset();
  };

  return (
    <section className="page-section testnet-journey vendor-portal">
      <div className="journey-intro">
        <div>
          <span className="eyebrow">VENDOR PORTAL · PROVE TO ACCESS</span>
          <h1>
            Approve the payout.
            <br />
            <span>Prove coverage privately.</span>
          </h1>
          <p>
            Approving payouts for <code>supplier:acme</code> requires commercial general liability
            insurance of at least $2M. Prove it from this browser without showing the policy, get
            access, then check the decision's receipt yourself.
          </p>
        </div>
        <div className="journey-network">
          <Badge variant="outline">Demo PEP · stand-in for Gatekeeper</Badge>
          <strong>{session ? short(session.subject.subject, 8) : "Not signed in"}</strong>
          <small>Demo identity, demo carrier, POD/GPC (beta, unaudited).</small>
          <Button disabled={busy} variant="secondary" onClick={reset}>
            Start over
          </Button>
        </div>
      </div>

      <Banner
        variant="alert"
        title="Demo-grade results"
        description="The sign-in authenticates nobody, every demo user may act for supplier:acme, and the insurance credential is minted in your browser with the domain pack's published demo carrier key. The flow, signatures and proofs are real; the conclusions are protocol demonstrations, not authorization."
      />

      <nav className="journey-progress" aria-label="Vendor portal steps">
        {steps.map((label, i) => (
          <Button
            key={label}
            variant={step === i ? "primary" : "secondary"}
            aria-current={step === i ? "step" : undefined}
            disabled
          >
            <span>{i + 1}</span>
            {label}
            {i < step ? " ✓" : ""}
          </Button>
        ))}
      </nav>
      <div aria-live="polite">
        {message && <p className="journey-notice">{message}</p>}
        {error && <Banner variant="error" title="This step needs attention" description={error} />}
      </div>

      <div className="guided-columns">
        <LayerCard className="infra-card guided-main">
          {step === 0 && (
            <>
              <span className="eyebrow">01 / SIGN IN</span>
              <h2>Who is asking?</h2>
              <p>
                The policy enforcement point (PEP) binds every proof request to an authenticated
                subject. Until Nathan sign-in issues RFC 9068 access tokens, the demo PEP mints a
                short-lived token for a fresh pseudonymous subject.
              </p>
              <div className="controls">
                <Button disabled={busy} onClick={signIn}>
                  Sign in with a demo identity
                </Button>
                <Button disabled variant="ghost">
                  Sign in with Nathan (coming later)
                </Button>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <span className="eyebrow">02 / REQUEST ACCESS</span>
              <h2>Approve a payout for supplier:acme</h2>
              <p>
                The portal asks the PEP to authorize <code>{VENDOR_PORTAL_ACTION}</code> on{" "}
                <code>{VENDOR_PORTAL_RESOURCE}</code>. Without a current proof the PEP answers with a
                challenge carrying a signed <code>attest.proof-request/v1</code> addressed to the verifier.
              </p>
              <Button disabled={busy} onClick={requestAccess}>
                Request vendor.payout.approve
              </Button>
            </>
          )}
          {step === 2 && challenge && requirement && (
            <>
              <span className="eyebrow">03 / PROVE PRIVATELY</span>
              <h2>Prove CGL coverage without showing it</h2>
              <p>
                Requirement <code>{challenge.proofRequest.requirement.id}</code> (digest{" "}
                <code>{short(challenge.proofRequest.requirement.digest, 8)}</code>, matched against the
                verifier's own definition): aggregate ≥ $2,000,000 and per occurrence ≥ $1,000,000.
              </p>
              <div className="guided-checklist">
                <p>
                  <strong>1. Enroll a holder key.</strong> A fresh key is bound to your subject at the
                  verifier, using your access token and a signature by the key.
                </p>
                <p>
                  <strong>2. Get a demo credential.</strong> The demo carrier's CGL credential for
                  supplier:acme (aggregate $5M, per occurrence $2.5M) is signed in this browser.
                </p>
                <p>
                  <strong>3. Prove.</strong> A GPC proof shows the hidden values meet the thresholds,
                  watermarked with this request. The verifier sees the proof, issuer and credential ID,
                  never the amounts. The PEP sees only the verifier's signed result.
                </p>
              </div>
              <p className="muted">
                Request expires {new Date(challenge.request.expiresAt).toLocaleTimeString()}.
              </p>
              <Button disabled={busy} onClick={proveAndPresent}>
                Enroll, prove and present
              </Button>
            </>
          )}
          {step === 3 && result && (
            <>
              <span className="eyebrow">04 / RETRY</span>
              <h2>Retry with the verifier's result</h2>
              <p>
                The PEP checks the result's signature against the verifier key it pins, that it answers
                exactly its pending request (subject, entity, requirement digest, decision) and that it
                is unexpired, then consumes the request once and allows.
              </p>
              <Button disabled={busy} onClick={retry}>
                Retry the payout approval
              </Button>
            </>
          )}
          {step === 4 && decision && (
            <>
              <span className="eyebrow">05 / DECISION RECEIPT</span>
              <h2>
                Access allowed. <Badge variant="success">allow</Badge>
              </h2>
              <p>
                Decision <code>{short(decision.decisionId, 12)}</code>. Every decision is a salted
                commitment chained to the previous one; epochs are sealed under an RFC 6962 Merkle root.
              </p>
              {!receipt ? (
                <Button disabled={busy} onClick={loadReceipt}>
                  Get and verify the receipt
                </Button>
              ) : (
                <ReceiptView receipt={receipt} verification={verification} anchor={anchor} />
              )}
            </>
          )}
        </LayerCard>
        <aside>
          <LayerCard className="infra-card">
            <h3>Who sees what</h3>
            <p>
              <strong>This browser:</strong> the credential, coverage amounts and holder key.
            </p>
            <p>
              <strong>Verifier:</strong> the GPC proof, the issuer, the subject it was enrolled to and
              the credential ID (for status). Not the amounts.
            </p>
            <p>
              <strong>PEP:</strong> a signed, short-lived result. Not the proof, credential or amounts.
            </p>
            <p>
              <strong>Chain:</strong> only epoch roots of salted decision commitments, when anchored.
            </p>
          </LayerCard>
          <LayerCard className="infra-card">
            <Collapsible.Root>
              <Collapsible.Trigger render={<Button variant="ghost" />}>
                Service endpoints <CaretDownIcon size={14} />
              </Collapsible.Trigger>
              <Collapsible.Panel>
                <p className="muted">
                  Point the journey at another PEP (for example real Gatekeeper) or verifier.
                  Changing them restarts the journey.
                </p>
                <InputGroup>
                  <InputGroup.Addon>PEP</InputGroup.Addon>
                  <InputGroup.Input
                    aria-label="Policy enforcement point base URL"
                    value={draft.pep}
                    onChange={(e) => setDraft({ ...draft, pep: e.target.value })}
                  />
                </InputGroup>
                <InputGroup>
                  <InputGroup.Addon>Verifier</InputGroup.Addon>
                  <InputGroup.Input
                    aria-label="Verifier base URL"
                    value={draft.verifier}
                    onChange={(e) => setDraft({ ...draft, verifier: e.target.value })}
                  />
                </InputGroup>
                <div className="controls">
                  <Button variant="secondary" disabled={busy} onClick={saveEndpoints}>
                    Use these endpoints
                  </Button>
                </div>
              </Collapsible.Panel>
            </Collapsible.Root>
          </LayerCard>
        </aside>
      </div>

      {(challenge || presentation || result || decision) && (
        <details className="quiet-details">
          <summary>Inspect the exchanged documents</summary>
          <pre>
            {json({
              proofRequest: challenge?.proofRequest,
              presentation: presentation && {
                ...presentation,
                proof: { ...presentation.proof, proof: "(Groth16 proof elided)" },
                holderSignature: "(holder POD signature elided)",
              },
              verificationResult: result && { jws: short(result.token, 24), expiresAt: result.expiresAt },
              decision,
            })}
          </pre>
        </details>
      )}
      {requirement && <p className="journey-footnote">{requirement.notice}</p>}
      <div className="controls">
        <LinkButton href="#/testnet" variant="ghost">
          ← Other onchain journeys
        </LinkButton>
      </div>
    </section>
  );
}

function ReceiptView({ receipt, verification, anchor }: {
  receipt: ReceiptResponse;
  verification: ReceiptVerification | null;
  anchor: AnchorCheck | null;
}) {
  const r = receipt.receipt;
  return (
    <div className="journey-result">
      <dl className="receipt-facts">
        <dt>Leaf (seq {r.seq})</dt>
        <dd><code>{r.leafHash}</code></dd>
        <dt>Previous leaf</dt>
        <dd><code>{r.prevHash}</code></dd>
        <dt>Epoch {r.epoch.epoch} root (seq {r.epoch.firstSeq}–{r.epoch.lastSeq}, {r.epoch.size} leaves)</dt>
        <dd><code>{r.epoch.root}</code></dd>
        <dt>Inclusion proof (index {r.leafIndex})</dt>
        <dd>
          {r.path.length === 0 ? (
            <span className="muted">Empty: this leaf is the whole epoch.</span>
          ) : (
            <ol>
              {r.path.map((h, i) => (
                <li key={i}><code>{h}</code></li>
              ))}
            </ol>
          )}
        </dd>
        <dt>Log</dt>
        <dd><code>{receipt.ledger.name}</code> · id <code>{short(receipt.ledger.logId, 10)}</code></dd>
      </dl>
      {verification && (
        <div className="controls">
          <Badge variant={verification.local.ok ? "success" : "error"}>
            {verification.local.ok ? "Commitment opens to this decision" : `Receipt check failed: ${verification.local.ok ? "" : verification.local.reason}`}
          </Badge>
          <Badge variant={verification.inclusion ? "success" : "error"}>
            {verification.inclusion ? "RFC 6962 inclusion verified in this browser" : "Inclusion proof failed"}
          </Badge>
        </div>
      )}
      {anchor?.status === "anchored" ? (
        <Banner
          variant={anchor.check.ok ? "default" : "error"}
          title={anchor.check.ok ? "Matches the root anchored on Sepolia" : "Does not match the anchored root"}
          description={`DecisionLogAnchor ${anchor.address}, epoch ${anchor.epoch.epoch}, read at block ${anchor.epoch.evidence.blockNumber} through two agreeing RPCs.`}
        />
      ) : anchor ? (
        <Banner
          variant="alert"
          title="Sealed locally — not yet anchored on-chain"
          description={anchor.status === "not-configured"
            ? `No DecisionLogAnchor is configured for Sepolia${configuredDecisionAnchor() ? "" : " in the network manifest"}. The receipt is checked against the root the PEP sealed, so it shows consistency, not that the PEP cannot later rewrite history.`
            : `DecisionLogAnchor ${anchor.address} has no epoch ${r.epoch.epoch} for this log yet. The receipt is checked against the root the PEP sealed.`}
        />
      ) : null}
      <details className="quiet-details">
        <summary>Opened decision (revealed to you only, with its salt)</summary>
        <pre>{json({ decision: r.decision, salt: r.salt })}</pre>
      </details>
    </div>
  );
}

/** Stable codes from the PEP and verifier, in words. */
function explain(code: string): string {
  const known: Record<string, string> = {
    holder_already_enrolled: "This holder key is enrolled to another account. Start over to use a fresh key.",
    request_replayed: "This proof request was already used. Request access again for a new one.",
    request_consumed: "This proof request was already used. Request access again for a new one.",
    request_expired: "The proof request expired. Request access again.",
    result_expired: "The verification result expired. Prove again.",
    untrusted_token_issuer: "The verifier does not trust this sign-in yet (its IDENTITY_PROVIDERS needs the demo identity issuer).",
    request_issuer_key_unavailable: "The verifier does not trust this PEP's request key yet (TRUSTED_PEPS).",
    demo_pep_misconfigured: "The demo PEP is not configured on this deployment yet.",
    verifier_misconfigured: "The verifier is not configured yet.",
    demo_quota_exhausted: "The demo's daily allowance is used up. Try again tomorrow.",
    attest_not_configured: "The demo PEP has no pinned verifier key yet.",
    "Failed to fetch": "A service could not be reached (network or CORS). Check the service endpoints.",
  };
  const hit = Object.keys(known).find((k) => code.includes(k));
  return hit ? `${known[hit]} (${code})` : code;
}
