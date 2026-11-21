/**
 * attest.proof-request/v1 — a policy enforcement point's signed request for a
 * private presentation. It binds who is asking (issuer), who verifies (audience),
 * which authenticated subject the answer is about, the exact pinned requirement,
 * the triggering decision, a nonce and a short validity window.
 */
import {digestOf, isDigest, isHttps, isText, isTime, need, parseJws, shape, signJws, verifyJws} from "./jws.ts";

export const PROOF_REQUEST_SCHEMA = "attest.proof-request/v1";
/** Upper bound on request lifetime. Proofs are generated interactively. */
export const MAX_REQUEST_LIFETIME_MS = 600_000;

/** An authenticated principal: the IdP issuer and its subject identifier. */
export interface SubjectRef {issuer: string; subject: string}
export interface ProofRequest {
  schema: typeof PROOF_REQUEST_SCHEMA;
  id: string;
  /** Requesting enforcement point (for example a Gatekeeper tenant). Results are addressed to it. */
  issuer: string;
  /** The verifier that must evaluate the presentation. */
  audience: string;
  subject: SubjectRef;
  /**
   * The entity the requirement must hold for (for example "supplier:acme"). The PEP is
   * responsible for having authorized `subject` to act for it; the verifier requires the
   * presented credential to be about exactly this entity.
   */
  credentialSubject: string;
  requirement: {id: string; digest: string};
  decisionId?: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function parseSubjectRef(value: unknown): SubjectRef {
  shape(value, ["issuer", "subject"]);
  need(isHttps(value.issuer) && isText(value.subject, 512), "invalid_subject_ref");
  return {issuer: value.issuer, subject: value.subject};
}
export function parseProofRequest(value: unknown): ProofRequest {
  shape(value, ["schema", "id", "issuer", "audience", "subject", "credentialSubject", "requirement", "nonce",
    "issuedAt", "expiresAt"], ["decisionId"]);
  need(value.schema === PROOF_REQUEST_SCHEMA, "unsupported_request_schema");
  need(isText(value.id, 256) && isHttps(value.issuer) && isHttps(value.audience), "invalid_request_binding");
  const subject = parseSubjectRef(value.subject);
  need(isText(value.credentialSubject, 512), "invalid_request_binding");
  shape(value.requirement, ["id", "digest"]);
  need(isText(value.requirement.id, 256) && isDigest(value.requirement.digest), "invalid_request_requirement");
  need(!Object.hasOwn(value, "decisionId") || isText(value.decisionId, 256), "invalid_request_binding");
  // At least 128 bits of base64url entropy.
  need(typeof value.nonce === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(value.nonce), "invalid_request_nonce");
  need(isTime(value.issuedAt) && isTime(value.expiresAt) && value.issuedAt < value.expiresAt &&
    value.expiresAt - value.issuedAt <= MAX_REQUEST_LIFETIME_MS, "invalid_request_time");
  return {
    schema: PROOF_REQUEST_SCHEMA, id: value.id, issuer: value.issuer, audience: value.audience, subject,
    credentialSubject: value.credentialSubject, requirement: {id: value.requirement.id, digest: value.requirement.digest},
    ...(Object.hasOwn(value, "decisionId") ? {decisionId: value.decisionId as string} : {}),
    nonce: value.nonce, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}
/** The digest is also the GPC watermark, so a proof cannot be replayed against another request. */
export const requestDigest = async (request: ProofRequest): Promise<string> => digestOf(parseProofRequest(request));

export const signProofRequest = async (request: ProofRequest, kid: string, privateKey: JsonWebKey): Promise<string> =>
  signJws(PROOF_REQUEST_SCHEMA, parseProofRequest(request), kid, privateKey);

export interface RequestVerification {
  /** Trusted enforcement-point keys. Never resolve keys from URLs inside the request. */
  resolveKey(issuer: string, kid: string): Promise<JsonWebKey | null>;
  /** This verifier's own identifier; the request must be addressed to it. */
  audience: string;
  now: number;
}
export async function verifyProofRequest(token: string, options: RequestVerification):
  Promise<{request: ProofRequest; digest: string}> {
  const parsed = parseJws(token, PROOF_REQUEST_SCHEMA);
  const request = parseProofRequest(parsed.payload);
  const key = await options.resolveKey(request.issuer, parsed.kid);
  need(key, "request_issuer_key_unavailable");
  await verifyJws(parsed, key);
  need(request.audience === options.audience, "request_audience_mismatch");
  need(isTime(options.now) && request.issuedAt <= options.now, "request_not_yet_valid");
  need(options.now < request.expiresAt, "request_expired");
  return {request, digest: await requestDigest(request)};
}
