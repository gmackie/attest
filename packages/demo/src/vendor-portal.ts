/**
 * Vendor portal journey (ATTE-20): the client side of "prove to access", shared by the web UI
 * and the end-to-end test.
 *
 *  1. sign in            → an IdP access token (demo identity today; Nathan, NATH-15, later)
 *  2. request the action → the PEP challenges with a signed attest.proof-request/v1
 *  3. enroll + present   → holder key bound at the verifier; a GPC presentation proves CGL
 *                          coverage privately; the verifier signs attest.verification-result/v1
 *  4. retry with result  → allow
 *  5. receipt            → the decision's leaf, epoch root and RFC 6962 inclusion proof, checked here
 *
 * Every service is reached through a base URL, so the same flow can point at real Gatekeeper.
 * Results are demo-grade: the accepted credential issuer is the domain pack's demo carrier,
 * whose signing key is public, and POD/GPC is a beta, unaudited backend.
 */
import { deriveSignerPublicKey, encodePrivateKey, POD } from "@pcd/pod";
import { DEMO_INSURANCE_ISSUER_PRIVATE_KEY } from "@attest/domains";
import { issueCriteriaPod } from "@attest/proofs";
import {
  ENROLLMENT_SCHEMA, parseRequirement, presentToRequest, requirementDigest, signEnrollment, verifyProofRequest,
  type Presentation, type ProofRequest, type RequirementDefinition, type SubjectRef,
} from "@attest/verifier";
import {
  chainStatusReaderFor, decisionLogId, explorerTxUrl, networkConfigs, readAnchoredEpoch,
  type ChainStatusReader,
  DEMO_PEP_LEDGER_PROFILE, GATEKEEPER_LEDGER_PROFILE, verifyDecisionReceipt,
  type AnchoredEpoch, type ContractManifest, verifyInclusion,
  type DecisionReceipt, type ReceiptCheck, type TrustedEpoch,
} from "@attest/chain-evm";

export type { Presentation, ProofRequest, RequirementDefinition };
export const VENDOR_PORTAL_ACTION = "vendor.payout.approve";
export const VENDOR_PORTAL_RESOURCE = "supplier:acme";
export const VENDOR_PORTAL_REQUIREMENT = "demo.insurance.cgl.min-2m";
/** The accepted-issuer id of the contractor-insurance pack's demo carrier in the verifier catalog. */
export const DEMO_CARRIER_ID = "issuer:carrier";
/** Synthetic coverage on the demo credential. Hidden from the PEP and the verifier. */
export const DEMO_COVERAGE = { aggregate: 5_000_000, per_occurrence: 2_500_000 } as const;
const LEDGER_PROFILES = [DEMO_PEP_LEDGER_PROFILE, GATEKEEPER_LEDGER_PROFILE];

export interface PortalEndpoints {
  /** PEP base: the demo PEP (`https://attest.gmac.io/api/demo-pep`) or a Gatekeeper base later. */
  pep: string;
  /** Verifier base (`https://verify.attest.gmac.io`). */
  verifier: string;
}
export const DEFAULT_ENDPOINTS: PortalEndpoints = {
  pep: "https://attest.gmac.io/api/demo-pep",
  verifier: "https://verify.attest.gmac.io",
};
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class PortalError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "PortalError";
  }
}
const trimSlash = (u: string) => u.replace(/\/+$/, "");

async function call<T>(fetcher: Fetch, url: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const text = init.body === undefined ? undefined : JSON.stringify(init.body);
  const res = await fetcher(url, {
    method: init.method ?? (text === undefined ? "GET" : "POST"),
    headers: {
      accept: "application/json",
      ...(text === undefined ? {} : { "content-type": "application/json" }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(text === undefined ? {} : { body: text }),
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new PortalError("invalid_response", res.status);
  }
  if (!res.ok) {
    const d = data as { code?: string; message?: string };
    throw new PortalError(d.message ?? d.code ?? `http_${res.status}`, res.status);
  }
  return data as T;
}

/* ------------------------------------------------------------------ 1. identity */

export interface Session { accessToken: string; subject: SubjectRef; expiresAt: number; demo: boolean }
/**
 * Stopgap: the demo PEP's demo identity mints an RFC 9068 access token for a fresh pseudonymous
 * subject. It authenticates nobody. Nathan sign-in (NATH-15) replaces this with a real token.
 */
export async function demoSignIn(endpoints: PortalEndpoints, fetcher: Fetch, now = Date.now()): Promise<Session> {
  const r = await call<{ access_token: string; expires_in: number; subject: SubjectRef; demo: boolean }>(
    fetcher, `${trimSlash(endpoints.pep)}/identity/token`, { method: "POST", body: {} });
  return { accessToken: r.access_token, subject: r.subject, expiresAt: now + r.expires_in * 1000, demo: r.demo === true };
}

/* ------------------------------------------------------------------ 2. authorize / challenge */

export interface ChallengeRequest {
  requestId: string;
  request: string;
  verifier: string;
  endpoint?: string;
  requirement: { id: string; digest: string };
  credentialSubject: string;
  expiresAt: number;
}
export interface AuthorizeResponse {
  outcome: "allow" | "challenge" | "deny";
  reason: string;
  decisionId: string;
  attest?: { requests?: ChallengeRequest[]; error?: string };
  evidence?: unknown[];
}
export const authorize = (endpoints: PortalEndpoints, fetcher: Fetch, session: Session,
  attest?: { requestId: string; result: string }) =>
  call<AuthorizeResponse>(fetcher, `${trimSlash(endpoints.pep)}/authorize`, {
    token: session.accessToken,
    body: { action: VENDOR_PORTAL_ACTION, resourceId: VENDOR_PORTAL_RESOURCE, ...(attest ? { attest } : {}) },
  });

/**
 * Wallet-side check of a challenge before asking for consent: the request is signed by a key the
 * PEP publishes, addressed to the verifier we are about to use, about our own subject and the
 * expected entity. (The JWKS is fetched from the PEP the user chose; the verifier independently
 * pins the PEP's keys, which is what actually protects the presentation.)
 */
export async function checkChallenge(endpoints: PortalEndpoints, fetcher: Fetch, challenge: ChallengeRequest,
  session: Session, now = Date.now()): Promise<ProofRequest> {
  const { keys } = await call<{ keys: (JsonWebKey & { kid?: string })[] }>(fetcher, `${trimSlash(endpoints.pep)}/jwks`);
  const { request } = await verifyProofRequest(challenge.request, {
    resolveKey: async (_issuer, kid) => {
      const k = keys.find((x) => x.kid === kid);
      return k ? { kty: k.kty!, crv: k.crv!, x: k.x!, y: k.y! } : null;
    },
    audience: challenge.verifier, now,
  });
  if (trimSlash(challenge.verifier) !== trimSlash(endpoints.verifier)) throw new PortalError("unexpected_verifier");
  if (request.subject.issuer !== session.subject.issuer || request.subject.subject !== session.subject.subject)
    throw new PortalError("request_subject_mismatch");
  if (request.credentialSubject !== VENDOR_PORTAL_RESOURCE || request.requirement.id !== VENDOR_PORTAL_REQUIREMENT ||
    request.id !== challenge.requestId)
    throw new PortalError("unexpected_request");
  return request;
}

/* ------------------------------------------------------------------ 3. holder: enroll and present */

export interface Holder { privateKey: string; publicKey: string }
export function newHolder(): Holder {
  const privateKey = encodePrivateKey(crypto.getRandomValues(new Uint8Array(32)));
  return { privateKey, publicKey: deriveSignerPublicKey(privateKey) };
}

/** The verifier's own definition, checked against the digest the PEP pinned in its request. */
export async function fetchRequirement(endpoints: PortalEndpoints, fetcher: Fetch, request: ProofRequest):
  Promise<{ definition: RequirementDefinition; synthetic: boolean; notice: string }> {
  const r = await call<{ requirement: unknown; synthetic: boolean; notice: string }>(fetcher,
    `${trimSlash(endpoints.verifier)}/v1/requirements/${encodeURIComponent(request.requirement.id)}`);
  const definition = parseRequirement(r.requirement);
  if (definition.id !== request.requirement.id || (await requirementDigest(definition)) !== request.requirement.digest)
    throw new PortalError("requirement_mismatch");
  return { definition, synthetic: r.synthetic === true, notice: r.notice };
}

/**
 * The demo carrier's CGL credential for supplier:acme, bound to the holder key. Minted in the
 * browser with the domain pack's published demo key: anyone can mint one, which is why the
 * requirement is `demo.` and every result is a demonstration.
 */
export function issueDemoCredential(definition: RequirementDefinition, holder: Holder): POD {
  return issueCriteriaPod({
    schema: definition.schema, subject: VENDOR_PORTAL_RESOURCE, holderPublicKey: holder.publicKey,
    issuerPublicKey: deriveSignerPublicKey(DEMO_INSURANCE_ISSUER_PRIVATE_KEY), challenge: "unused",
    criteria: definition.criteria,
  }, DEMO_COVERAGE, DEMO_INSURANCE_ISSUER_PRIVATE_KEY);
}

export const enroll = (endpoints: PortalEndpoints, fetcher: Fetch, session: Session, holder: Holder, now = Date.now()) => {
  const statement = {
    schema: ENROLLMENT_SCHEMA, verifier: trimSlash(endpoints.verifier), subject: session.subject,
    holderPublicKey: holder.publicKey, issuedAt: now,
  } as const;
  return call<{ enrolled: boolean; existing: boolean }>(fetcher, `${trimSlash(endpoints.verifier)}/v1/enrollments`, {
    token: session.accessToken, body: { statement, signature: signEnrollment(statement, holder.privateKey) },
  });
};

/** Proof generation runs here; hidden values never leave this function. */
export const prove = (request: ProofRequest, definition: RequirementDefinition, credential: POD, holder: Holder,
  artifacts?: string): Promise<Presentation> =>
  presentToRequest({
    request, definition, credential, credentialIssuer: DEMO_CARRIER_ID, credentialSubject: VENDOR_PORTAL_RESOURCE,
    holderPrivateKey: holder.privateKey, ...(artifacts === undefined ? {} : { artifacts }),
  });

export const submitPresentation = (endpoints: PortalEndpoints, fetcher: Fetch, challenge: ChallengeRequest,
  presentation: Presentation) =>
  call<{ result: string; expiresAt: number }>(fetcher, `${trimSlash(endpoints.verifier)}/v1/presentations`, {
    body: { request: challenge.request, presentation },
  });

/* ------------------------------------------------------------------ 5. receipt */

export interface ReceiptResponse {
  receipt: DecisionReceipt;
  ledger: {
    name: string;
    logId: string;
    anchor: { status: "not-configured" | "misconfigured" | "awaiting-anchoring" | "anchored"; chainId?: number; address?: string;
      logId?: string; lastError?: { code: string; epoch: number; at: number } };
  };
}
export const fetchReceipt = (endpoints: PortalEndpoints, fetcher: Fetch, session: Session, decisionId: string) =>
  call<ReceiptResponse>(fetcher, `${trimSlash(endpoints.pep)}/decisions/${encodeURIComponent(decisionId)}/receipt`,
    { token: session.accessToken });

export interface ReceiptVerification {
  /** The receipt opens to its decision and is included under the epoch root it names. */
  local: ReceiptCheck;
  /** The decision is the one the PEP answered, about the caller. */
  matchesDecision: boolean;
  /** The bare RFC 6962 inclusion check of the leaf (same as inside `local`), shown step by step. */
  inclusion: boolean;
}
/** Checks a receipt in this process. The profile is chosen from labels we know, never taken from the server. */
export async function verifyReceipt(receipt: DecisionReceipt, decisionId: string, trusted?: TrustedEpoch): Promise<ReceiptVerification> {
  const profile = LEDGER_PROFILES.find((p) => p.proof === receipt.schema);
  if (!profile) return { local: { ok: false, reason: "malformed" }, matchesDecision: false, inclusion: false };
  const local = await verifyDecisionReceipt(profile, receipt, trusted);
  const inclusion = await verifyInclusion(receipt.leafHash, receipt.leafIndex, receipt.epoch.size, receipt.path, receipt.epoch.root);
  return { local, inclusion, matchesDecision: receipt.decision.id === decisionId };
}

/**
 * DecisionLogAnchor deployments this client trusts, per chain. The manifest entry wins when present
 * (ATTE-26); otherwise the Sepolia deployment the demo PEP publishes to. The address a PEP reports is
 * only compared against this pin, never used to choose the contract to read.
 */
export const SEPOLIA_DECISION_LOG_ANCHOR = "0x7020EE914B517Da8F7F8D42Dc436763898FaA8Ad";
export const configuredDecisionAnchor = (chainId: number = networkConfigs.sepolia.chainId): `0x${string}` | null => {
  if (chainId !== networkConfigs.sepolia.chainId) return null;
  return ((networkConfigs.sepolia.contracts as ContractManifest).DecisionLogAnchor?.default as `0x${string}` | undefined) ??
    SEPOLIA_DECISION_LOG_ANCHOR;
};
/** Log ids this client expects per receipt profile; a PEP cannot point a receipt at another log. */
export const DEMO_PEP_LOG_NAME = "attest-demo-pep";
const expectedLogId = async (receipt: DecisionReceipt): Promise<string | null> =>
  receipt.schema === DEMO_PEP_LEDGER_PROFILE.proof ? decisionLogId(DEMO_PEP_LOG_NAME) : null;

export interface ReportedAnchor {
  chainId: number; address: string; logId: string; txHash: string | null; blockNumber: number | null;
}
export type AnchorCheck =
  | { status: "not-configured" }
  | { status: "awaiting-anchoring" }
  /** The PEP reports an anchoring transaction, but the settled chain does not hold the epoch yet. */
  | { status: "awaiting-finality"; address: string; txHash: string | null; explorerUrl: string | null }
  | { status: "anchored"; address: string; epoch: AnchoredEpoch; check: ReceiptCheck; txHash: string | null; explorerUrl: string | null }
  | { status: "untrusted-anchor"; reason: string };

/** The settled-block reader the browser uses: two agreeing public RPCs, 3 confirmations (as ATTE-27). */
export const demoAnchorReader = () => chainStatusReaderFor("sepolia", {
  finality: { kind: "confirmations", confirmations: 3 }, maxBlockAgeMs: 5 * 60_000,
});

/**
 * Reads the receipt's epoch from DecisionLogAnchor at a settled block and checks the receipt against
 * that root and span, not the PEP's copy. Only the pinned contract and the expected log id are used.
 */
export async function verifyAgainstChain(receipt: DecisionReceipt, ledger: ReceiptResponse["ledger"], decisionId: string,
  reader: ChainStatusReader = demoAnchorReader(),
  trustedAnchor: (chainId: number) => string | null = configuredDecisionAnchor): Promise<AnchorCheck> {
  const reported = (receipt.epoch.anchor ?? null) as ReportedAnchor | null;
  if (!reported) return ledger.anchor.status === "awaiting-anchoring" ? { status: "awaiting-anchoring" } : { status: "not-configured" };
  const address = trustedAnchor(reported.chainId);
  if (!address) return { status: "untrusted-anchor", reason: `no trusted DecisionLogAnchor on chain ${reported.chainId}` };
  if (reported.address.toLowerCase() !== address.toLowerCase())
    return { status: "untrusted-anchor", reason: `PEP reports ${reported.address}, this client trusts ${address}` };
  const logId = (await expectedLogId(receipt)) ?? reported.logId;
  if (!/^0x[0-9a-f]{64}$/.test(logId) || reported.logId !== logId)
    return { status: "untrusted-anchor", reason: "the receipt names an unexpected log" };
  const txHash = reported.txHash && /^0x[0-9a-f]{64}$/.test(reported.txHash) ? reported.txHash : null;
  const explorerUrl = txHash ? explorerTxUrl("sepolia", txHash) : null;
  const epoch = await readAnchoredEpoch(reader, { address: address as `0x${string}`, log: logId as `0x${string}`, epoch: receipt.epoch.epoch });
  if (!epoch) return { status: "awaiting-finality", address, txHash, explorerUrl };
  const { local } = await verifyReceipt(receipt, decisionId, epoch);
  return { status: "anchored", address, epoch, check: local, txHash, explorerUrl };
}

/**
 * The journey's verdict on a receipt. Throws unless the receipt opens, is included and is the
 * decision we were given, and, when an anchored epoch exists, matches it. A mismatch with the
 * chain is a failure, never a success with a caveat.
 */
export function receiptVerdict(v: ReceiptVerification, anchor: AnchorCheck): "anchored" | "sealed-locally" {
  if (!v.local.ok || !v.inclusion || !v.matchesDecision) throw new PortalError("receipt_invalid");
  if (anchor.status === "untrusted-anchor") throw new PortalError(`receipt_anchor_untrusted:${anchor.reason}`);
  if (anchor.status === "anchored") {
    if (!anchor.check.ok) throw new PortalError(`receipt_anchor_mismatch:${anchor.check.reason}`);
    return "anchored";
  }
  return "sealed-locally";
}
