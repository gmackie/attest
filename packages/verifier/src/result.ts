/**
 * attest.verification-result/v1 — the verifier's short-lived, signed statement
 * that a pinned requirement was satisfied for an authenticated subject.
 *
 * It intentionally carries no hidden values, holder key or credential content
 * ID, so the enforcement point cannot correlate holders across requests. It is
 * a verifier assertion, not a zero-knowledge proof: consumers trust the
 * verifier's key for the stated requirement.
 */
import {isDigest, isHttps, isText, isTime, need, parseJws, shape, signJws, verifyJws} from "./jws.ts";
import {parseSubjectRef, type SubjectRef} from "./request.ts";

export const VERIFICATION_RESULT_SCHEMA = "attest.verification-result/v1";
export const MAX_RESULT_TTL_MS = 300_000;

/**
 * - `chain`: credential status read on-chain (chainId, blockNumber, blockHash required).
 * - `registry`: credential-level status from an off-chain status registry.
 * - `issuer-authority`: only the issuer's authority was checked; no credential-level
 *   revocation source was consulted. PEPs that need revocation must refuse it.
 */
export const STATUS_SOURCES = ["chain", "registry", "issuer-authority"] as const;
export interface StatusEvidence {
  source: (typeof STATUS_SOURCES)[number];
  observedAt: number;
  chainId?: number;
  blockNumber?: number;
  blockHash?: string;
}
export interface VerificationResult {
  schema: typeof VERIFICATION_RESULT_SCHEMA;
  id: string;
  /** The verifier. */
  issuer: string;
  /** The enforcement point that issued the request. */
  audience: string;
  requestId: string;
  requestDigest: string;
  decisionId?: string;
  subject: SubjectRef;
  /** The entity the requirement was proven for; equals the request's credentialSubject. */
  credentialSubject: string;
  requirement: {id: string; digest: string};
  credentialIssuer: string;
  status: StatusEvidence;
  issuedAt: number;
  expiresAt: number;
}

export function parseStatusEvidence(value: unknown): StatusEvidence {
  shape(value, ["source", "observedAt"], ["chainId", "blockNumber", "blockHash"]);
  need((STATUS_SOURCES as readonly unknown[]).includes(value.source) && isTime(value.observedAt), "invalid_status_evidence");
  const chain = value.source === "chain";
  need(chain === Object.hasOwn(value, "chainId") && chain === Object.hasOwn(value, "blockNumber") &&
    chain === Object.hasOwn(value, "blockHash"), "invalid_status_evidence");
  if (chain) need(isTime(value.chainId) && (value.chainId as number) > 0 && isTime(value.blockNumber) &&
    typeof value.blockHash === "string" && /^0x[a-f0-9]{64}$/.test(value.blockHash), "invalid_status_evidence");
  return {
    source: value.source as StatusEvidence["source"], observedAt: value.observedAt,
    ...(chain ? {chainId: value.chainId as number, blockNumber: value.blockNumber as number, blockHash: value.blockHash as string} : {}),
  };
}
export function parseVerificationResult(value: unknown): VerificationResult {
  shape(value, ["schema", "id", "issuer", "audience", "requestId", "requestDigest", "subject", "credentialSubject",
    "requirement", "credentialIssuer", "status", "issuedAt", "expiresAt"], ["decisionId"]);
  need(value.schema === VERIFICATION_RESULT_SCHEMA, "unsupported_result_schema");
  need(isText(value.id, 256) && isHttps(value.issuer) && isHttps(value.audience) && isText(value.requestId, 256) &&
    isDigest(value.requestDigest) && isText(value.credentialIssuer, 256), "invalid_result_binding");
  need(!Object.hasOwn(value, "decisionId") || isText(value.decisionId, 256), "invalid_result_binding");
  const subject = parseSubjectRef(value.subject);
  need(isText(value.credentialSubject, 512), "invalid_result_binding");
  shape(value.requirement, ["id", "digest"]);
  need(isText(value.requirement.id, 256) && isDigest(value.requirement.digest), "invalid_result_binding");
  const status = parseStatusEvidence(value.status);
  need(isTime(value.issuedAt) && isTime(value.expiresAt) && value.issuedAt < value.expiresAt &&
    value.expiresAt - value.issuedAt <= MAX_RESULT_TTL_MS && status.observedAt <= value.issuedAt, "invalid_result_time");
  return {
    schema: VERIFICATION_RESULT_SCHEMA, id: value.id, issuer: value.issuer, audience: value.audience,
    requestId: value.requestId, requestDigest: value.requestDigest,
    ...(Object.hasOwn(value, "decisionId") ? {decisionId: value.decisionId as string} : {}),
    subject, credentialSubject: value.credentialSubject,
    requirement: {id: value.requirement.id, digest: value.requirement.digest},
    credentialIssuer: value.credentialIssuer, status, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}
export const signVerificationResult = async (result: VerificationResult, kid: string, privateKey: JsonWebKey): Promise<string> =>
  signJws(VERIFICATION_RESULT_SCHEMA, parseVerificationResult(result), kid, privateKey);

export interface ResultVerification {
  /** Keys of verifiers this enforcement point trusts. */
  resolveKey(verifier: string, kid: string): Promise<JsonWebKey | null>;
  /** Whether this verifier may vouch for the requirement. */
  trustedVerifier(verifier: string, requirementId: string): Promise<boolean>;
  /** The consuming enforcement point's own identifier. */
  audience: string;
  now: number;
  /**
   * Optional: status evidence sources this enforcement point accepts. For example
   * ["chain"] refuses results whose status was issuer-level only ("issuer-authority").
   */
  acceptedStatusSources?: readonly StatusEvidence["source"][];
  /**
   * What this enforcement point asked for. A result is accepted only for the exact pending
   * request, so it cannot be relayed to another user, entity, requirement or decision.
   */
  expected: {
    requestDigest: string;
    subject: SubjectRef;
    credentialSubject: string;
    requirement: {id: string; digest: string};
    decisionId?: string;
  };
}
/** For enforcement points such as Gatekeeper. Enforces every binding to the PEP's own pending request. */
export async function verifyVerificationResult(token: string, options: ResultVerification): Promise<VerificationResult> {
  const parsed = parseJws(token, VERIFICATION_RESULT_SCHEMA);
  const result = parseVerificationResult(parsed.payload);
  const key = await options.resolveKey(result.issuer, parsed.kid);
  need(key, "verifier_key_unavailable");
  await verifyJws(parsed, key);
  need(await options.trustedVerifier(result.issuer, result.requirement.id), "untrusted_verifier");
  need(result.audience === options.audience, "result_audience_mismatch");
  need(isTime(options.now) && result.issuedAt <= options.now, "result_not_yet_valid");
  need(options.now < result.expiresAt, "result_expired");
  need(!options.acceptedStatusSources || options.acceptedStatusSources.includes(result.status.source),
    "status_source_not_accepted");
  const e = options.expected;
  need(result.requestDigest === e.requestDigest && result.subject.issuer === e.subject.issuer &&
    result.subject.subject === e.subject.subject && result.credentialSubject === e.credentialSubject &&
    result.requirement.id === e.requirement.id && result.requirement.digest === e.requirement.digest &&
    result.decisionId === e.decisionId, "result_binding_mismatch");
  return result;
}
