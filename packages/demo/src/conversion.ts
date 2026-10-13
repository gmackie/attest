import { POD, deriveSignerPublicKey, type PODEntries } from "@pcd/pod";
import { canonicalJson, commitValue } from "@attest/core";
import {
  issueCriteriaPod, proveCriteria, verifyCriteria,
  type CriteriaRequest, type GpcProofEnvelope,
} from "@attest/proofs";
import {
  entitlementNullifier, packPalette, provenanceCommitment, signConversionVoucher,
  type Address, type Hex, type ConversionVoucher,
} from "@attest/chain-evm";
import { Effect } from "effect";

/** All identities and engagements in the reference flow are fictional. */
export const CONVERSION_CLAIM_SCHEMA = "attest.conversion.claim.v1";
const maxVoucherLifetimeSeconds = 3600;
const maxStatusAgeMs = 10_000;

export type ConversionClaim = Readonly<{
  schema: typeof CONVERSION_CLAIM_SCHEMA;
  id: string;
  subject: string;
  holderPublicKey: string;
  issuerPublicKey: string;
  contentID: string;
  eventCommitment: Hex;
  pod: ReturnType<POD["toJSON"]>;
}>;

export type ConversionPolicy = Readonly<{
  id: Hex;
  schema: typeof CONVERSION_CLAIM_SCHEMA;
  scope: Hex;
  minimumScore: number;
  mintAmount: bigint; // Raw ERC-20 units (18 decimals), never a USD valuation.
  palette: readonly [number, number, number, number]; // basis points, sum 10,000
}>;

export type ConversionIntent = Readonly<{
  kind: "AttestConversionIntent";
  version: 1;
  chainId: 11155111;
  token: Address;
  recipient: Address;
  policyId: Hex;
  id: string;
  contentID: string;
  eventCommitment: Hex;
  subject: string;
  holderPublicKey: string;
  issuerAccount: Address;
  issuerPublicKey: string;
  expiresAt: number; // Unix seconds
}>;

export type PrivateConversionPresentation = Readonly<{
  kind: "AttestPrivateConversion";
  intentCommitment: string;
  proof: GpcProofEnvelope;
  holderConsent: ReturnType<POD["toJSON"]>;
}>;

/** Trusted external, fresh registry reading. Caller-supplied claims are never authority. */
export type CredentialSnapshot = Readonly<{
  id: string;
  contentID: string;
  issuerAccount: Address;
  issuerPublicKey: string;
  subject: string;
  holderPublicKey: string;
  scope: Hex;
  active: boolean;
  observedAtMs: number;
  validUntilSeconds: number;
}>;

export type ConversionVerifierPorts = Readonly<{
  nowMs: () => number;
  readCredential: (intent: ConversionIntent) => Promise<CredentialSnapshot | null>;
  acceptedIssuer: (issuer: Address, signingKey: string, scope: Hex) => Promise<boolean>;
  /** Optional early check. The EVM contract remains the final spend-once authority. */
  isAlreadySpent?: (nullifier: Hex) => Promise<boolean>;
}>;

export type VerifiedConversion = Readonly<{
  voucher: ConversionVoucher;
  intentCommitment: string;
}>;

const isHex32 = (x: string): x is Hex => /^0x[0-9a-fA-F]{64}$/.test(x);
const isAddress = (x: string) => /^0x[0-9a-fA-F]{40}$/.test(x);
const requireValid = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

export function validateConversionPolicy(policy: ConversionPolicy): void {
  requireValid(isHex32(policy.id) && isHex32(policy.scope), "Invalid policy commitments");
  requireValid(policy.schema === CONVERSION_CLAIM_SCHEMA, "Unsupported claim schema");
  requireValid(Number.isInteger(policy.minimumScore) && policy.minimumScore >= 1 &&
    policy.minimumScore <= 10_000, "Invalid minimum score");
  requireValid(policy.mintAmount > 0n && policy.mintAmount <= 1_000_000n * 10n ** 18n, "Invalid mint amount");
  packPalette(policy.palette);
}

export function validateIntent(intent: ConversionIntent, policy: ConversionPolicy, nowMs: number): void {
  requireValid(intent.kind === "AttestConversionIntent" && intent.version === 1 &&
    intent.chainId === 11155111 && intent.policyId.toLowerCase() === policy.id.toLowerCase(),
  "Wrong conversion domain or policy");
  requireValid(isAddress(intent.token) && isAddress(intent.recipient) && isAddress(intent.issuerAccount),
    "Invalid address");
  requireValid(intent.id.length >= 8 && intent.id.length <= 128 &&
    intent.subject.length > 0 && intent.subject.length <= 200, "Invalid claim identity");
  requireValid(/^\d+$/.test(intent.contentID) && isHex32(intent.eventCommitment) &&
    intent.holderPublicKey.length > 20 && intent.issuerPublicKey.length > 20, "Invalid claim binding");
  const now = Math.floor(nowMs / 1000);
  requireValid(Number.isSafeInteger(intent.expiresAt) && intent.expiresAt > now &&
    intent.expiresAt <= now + maxVoucherLifetimeSeconds, "Expired or excessive mint authorization");
}

/** Signed private record. Event commitments MUST identify real unique engagements,
 * remain stable across reissuance, and have enough entropy to resist guessing. */
export function issueConversionClaim(input: {
  id: string;
  subject: string;
  holderPublicKey: string;
  eventCommitment: Hex;
  score: number;
  validThrough: string;
}, issuerPrivateKey: string): ConversionClaim {
  if (!isHex32(input.eventCommitment) || !Number.isInteger(input.score) ||
      input.score < 0 || input.score > 10_000 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.validThrough))
    throw new Error("Invalid issuance input");
  const issuerPublicKey = deriveSignerPublicKey(issuerPrivateKey);
  const req: CriteriaRequest = {
    schema: CONVERSION_CLAIM_SCHEMA,
    subject: input.subject,
    holderPublicKey: input.holderPublicKey,
    issuerPublicKey,
    challenge: "issuance",
    criteria: [
      { field: "id", operator: "eq", value: input.id, kind: "text" },
      { field: "event", operator: "eq", value: input.eventCommitment, kind: "text" },
      { field: "score", operator: "gte", value: 0, kind: "number" },
      { field: "validThrough", operator: "gte", value: input.validThrough, kind: "date" },
    ],
  };
  const pod = issueCriteriaPod(req, {
    id: input.id, event: input.eventCommitment, score: input.score,
    validThrough: input.validThrough,
  }, issuerPrivateKey);
  return {
    schema: CONVERSION_CLAIM_SCHEMA, id: input.id, subject: input.subject,
    holderPublicKey: input.holderPublicKey, issuerPublicKey,
    contentID: pod.contentID.toString(), eventCommitment: input.eventCommitment,
    pod: pod.toJSON(),
  };
}

async function claimRequirement(intent: ConversionIntent, policy: ConversionPolicy): Promise<CriteriaRequest> {
  return {
    contentID: intent.contentID,
    schema: policy.schema,
    subject: intent.subject,
    holderPublicKey: intent.holderPublicKey,
    issuerPublicKey: intent.issuerPublicKey,
    challenge: await commitValue(intent),
    criteria: [
      { field: "id", operator: "eq", value: intent.id, kind: "text" },
      { field: "event", operator: "eq", value: intent.eventCommitment, kind: "text" },
      { field: "score", operator: "gte", value: policy.minimumScore, kind: "number" },
      { field: "validThrough", operator: "gte", value: new Date(intent.expiresAt * 1000).toISOString().slice(0, 10), kind: "date" },
    ],
  };
}
function consentPayload(intent: ConversionIntent, proofCommitment: string) {
  return canonicalJson({ purpose: "ATTEST/PRIVATE_CONVERSION/v1", intent, proofCommitment });
}

/** The signed claim stays in the holder's wallet; only the GPC presentation leaves. */
export async function preparePrivateConversion(
  claim: ConversionClaim,
  intent: ConversionIntent,
  policy: ConversionPolicy,
  holderPrivateKey: string,
  artifacts?: string,
): Promise<PrivateConversionPresentation> {
  validateConversionPolicy(policy);
  validateIntent(intent, policy, Date.now());
  if (claim.id !== intent.id || claim.contentID !== intent.contentID ||
      claim.eventCommitment.toLowerCase() !== intent.eventCommitment.toLowerCase() ||
      claim.subject !== intent.subject || claim.holderPublicKey !== intent.holderPublicKey ||
      claim.issuerPublicKey !== intent.issuerPublicKey ||
      deriveSignerPublicKey(holderPrivateKey) !== intent.holderPublicKey)
    throw new Error("Claim, issuer or holder does not match the mint intent");
  const pod = POD.fromJSON(claim.pod);
  if (!pod.verifySignature() || pod.contentID.toString() !== claim.contentID ||
      pod.signerPublicKey !== claim.issuerPublicKey)
    throw new Error("Signed claim invalid");
  const proof = await proveCriteria(pod, await claimRequirement(intent, policy), artifacts);
  const holderConsent = POD.sign(
    { consent: { type: "string", value: consentPayload(intent, proof.proofCommitment) } } satisfies PODEntries,
    holderPrivateKey,
  ).toJSON();
  return {
    kind: "AttestPrivateConversion",
    intentCommitment: await commitValue(intent),
    proof,
    holderConsent,
  };
}

/** Proof-verifier bridge: verifies the real private proof, current independent
 * credential/authority status and holder consent; derives a FIXED policy payout.
 * It NEVER trusts an amount or palette supplied by the presenter. */
export async function verifyPrivateConversion(
  presentation: PrivateConversionPresentation,
  intent: ConversionIntent,
  policy: ConversionPolicy,
  ports: ConversionVerifierPorts,
  artifacts?: string,
): Promise<VerifiedConversion> {
  validateConversionPolicy(policy);
  const nowMs = ports.nowMs();
  validateIntent(intent, policy, nowMs);
  const intentCommitment = await commitValue(intent);
  if (presentation.kind !== "AttestPrivateConversion" ||
      presentation.intentCommitment !== intentCommitment)
    throw new Error("Intent not bound to this presentation");
  const holder = POD.fromJSON(presentation.holderConsent);
  if (!holder.verifySignature() || holder.signerPublicKey !== intent.holderPublicKey ||
      holder.content.asEntries().consent?.value !== consentPayload(intent, presentation.proof.proofCommitment))
    throw new Error("Holder did not approve this exact mint");
  const snapshot = await ports.readCredential(intent);
  // The trusted status service may finish the read AFTER our initial timestamp.
  // Validate freshness against an observation captured after the awaited read.
  const checkedAtMs = ports.nowMs();
  if (snapshot === null || !snapshot.active ||
      snapshot.id !== intent.id || snapshot.contentID !== intent.contentID ||
      snapshot.subject !== intent.subject ||
      snapshot.holderPublicKey !== intent.holderPublicKey ||
      snapshot.issuerAccount.toLowerCase() !== intent.issuerAccount.toLowerCase() ||
      snapshot.issuerPublicKey !== intent.issuerPublicKey ||
      snapshot.scope.toLowerCase() !== policy.scope.toLowerCase() ||
      !Number.isSafeInteger(snapshot.observedAtMs) || snapshot.observedAtMs > checkedAtMs ||
      checkedAtMs - snapshot.observedAtMs > maxStatusAgeMs ||
      snapshot.validUntilSeconds < intent.expiresAt)
    throw new Error("Missing, stale, expired or mismatched anchored credential");
  if (!await ports.acceptedIssuer(intent.issuerAccount, intent.issuerPublicKey, policy.scope))
    throw new Error("Issuer lacks independently recognized authority");
  if (!await verifyCriteria(presentation.proof, await claimRequirement(intent, policy), artifacts))
    throw new Error("Private claim proof failed verification");
  const nullifier = entitlementNullifier(intent.eventCommitment);
  if (ports.isAlreadySpent && await ports.isAlreadySpent(nullifier))
    throw new Error("Entitlement already redeemed");
  return {
    intentCommitment,
    voucher: {
      policyId: policy.id,
      nullifier,
      proofCommitment: presentation.proof.proofCommitment as Hex,
      provenanceCommitment: provenanceCommitment(intent.eventCommitment, policy.id),
      recipient: intent.recipient,
      amount: policy.mintAmount,
      expiresAt: BigInt(intent.expiresAt),
      palette: packPalette(policy.palette),
    },
  };
}

/** Server-only: do not put this signer key into a browser, repository or demo build.
 * The caller is responsible for a trusted, rate-limited, monitored key service. */
export async function authorizePrivateConversion(
  presentation: PrivateConversionPresentation,
  intent: ConversionIntent,
  policy: ConversionPolicy,
  ports: ConversionVerifierPorts,
  authorizerPrivateKey: Hex,
  artifacts?: string,
): Promise<VerifiedConversion & { signature: Hex }> {
  const verified = await verifyPrivateConversion(presentation, intent, policy, ports, artifacts);
  return {
    ...verified,
    signature: await signConversionVoucher(authorizerPrivateKey, intent.token, verified.voucher, intent.chainId),
  };
}

export class ConversionError extends Error {
  readonly _tag = "ConversionError";
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : "Conversion rejected", { cause }); }
}

export const authorizePrivateConversionEffect = (
  ...args: Parameters<typeof authorizePrivateConversion>
) => Effect.tryPromise({
  try: () => authorizePrivateConversion(...args),
  catch: (cause) => new ConversionError(cause),
});
