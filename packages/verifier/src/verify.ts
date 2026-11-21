/**
 * Verifier service core. Every trust decision is an injected port: request
 * keys, the pinned requirement, issuer authority, holder enrollment, credential
 * status and replay. Nothing is fetched from URLs inside the request or the
 * presentation. A local policy match here is backed by a GPC proof, but GPC is a
 * beta, unaudited backend; results are labelled as verifier assertions.
 */
import {verifyCriteria, type CriteriaRequest, type GpcProofEnvelope} from "@attest/proofs";
import {asVerifierError, isHttps, isTime, need} from "./jws.ts";
import {criteriaRequestFor, holderSignatureValid, parsePresentation} from "./presentation.ts";
import {verifyProofRequest, type SubjectRef} from "./request.ts";
import {parseRequirement, requirementDigest, type RequirementDefinition} from "./requirement.ts";
import {
  MAX_RESULT_TTL_MS, parseStatusEvidence, signVerificationResult, VERIFICATION_RESULT_SCHEMA,
  type StatusEvidence, type VerificationResult,
} from "./result.ts";

export interface CredentialStatus {
  status: "active" | "revoked" | "superseded" | "expired";
  /** End of the issuer-asserted validity or status lease, whichever is earlier. */
  validUntil: number;
  evidence: StatusEvidence;
}
export interface PresentationVerifierPorts {
  /** This verifier's identifier (https). Requests must be addressed to it; results are issued by it. */
  verifierId: string;
  resolveRequestKey(issuer: string, kid: string): Promise<JsonWebKey | null>;
  /** The verifier's own requirement catalog. */
  requirement(id: string): Promise<RequirementDefinition | null>;
  /** Scoped issuer authority (for example an @attest/authority graph lookup) at verification time. */
  authorizedIssuer(credentialIssuer: string, requirementId: string, at: number): Promise<boolean>;
  /** Enrollment: whether this holder key belongs to the authenticated subject. */
  holderBound(subject: SubjectRef, holderPublicKey: string): Promise<boolean>;
  /** Current status of the presented credential, for example ChainStatusReader at a finalized block. */
  status(query: {credentialIssuer: string; schema: string; contentId: string}): Promise<CredentialStatus | null>;
  /** Atomically consume a request id once. Returns false if it was already used. */
  consumeRequest(requestId: string, digest: string, expiresAt: number): Promise<boolean>;
  resultKey: {kid: string; privateKey: JsonWebKey};
  now(): number;
  /** Maximum age of a status observation (≤ 60 s). */
  maxStatusAgeMs: number;
  /** Result lifetime (≤ 5 min); further capped by the status lease. */
  resultTtlMs: number;
  newId(): string;
  proofArtifacts?: string;
  /** Proof backend; defaults to GPC verifyCriteria. */
  verifyProof?(proof: GpcProofEnvelope, request: CriteriaRequest, artifacts?: string): Promise<boolean>;
}
export interface PresentationVerification {result: VerificationResult; token: string}

export async function verifyPresentationForRequest(requestToken: string, presentation: unknown,
  ports: PresentationVerifierPorts): Promise<PresentationVerification> {
  try {
    return await run(requestToken, presentation, ports);
  } catch (cause) {
    throw asVerifierError(cause, "verification_unavailable");
  }
}

async function run(requestToken: string, value: unknown, ports: PresentationVerifierPorts): Promise<PresentationVerification> {
  need(isHttps(ports.verifierId) && isTime(ports.maxStatusAgeMs) && ports.maxStatusAgeMs > 0 &&
    ports.maxStatusAgeMs <= 60_000 && isTime(ports.resultTtlMs) && ports.resultTtlMs > 0 &&
    ports.resultTtlMs <= MAX_RESULT_TTL_MS, "invalid_verifier_configuration");
  const now = ports.now();
  need(isTime(now), "invalid_verifier_clock");

  // 1. The request: signed by a trusted enforcement point, addressed to us, unexpired.
  const {request, digest} = await verifyProofRequest(requestToken, {
    resolveKey: (issuer, kid) => ports.resolveRequestKey(issuer, kid), audience: ports.verifierId, now,
  });

  // 2. The requirement: our own definition, pinned by the request digest.
  const found = await ports.requirement(request.requirement.id);
  need(found, "unknown_requirement");
  const definition = parseRequirement(found);
  need(definition.id === request.requirement.id &&
    await requirementDigest(definition) === request.requirement.digest, "requirement_mismatch");

  // 3. The presentation answers exactly this request.
  const presentation = parsePresentation(value);
  need(presentation.requestDigest === digest, "presentation_request_mismatch");
  need(presentation.credential.subject === request.credentialSubject, "credential_subject_mismatch");

  // 4. Issuer: accepted by the definition and currently authorized for this requirement.
  const issuer = definition.acceptedIssuers.find(i => i.id === presentation.credential.issuer);
  need(issuer, "unaccepted_credential_issuer");
  need(await ports.authorizedIssuer(issuer.id, definition.id, now), "unauthorized_credential_issuer");

  // 5. Holder: in possession of the key (checked first, so enrollment cannot be probed with
  //    arbitrary public keys), and enrolled to the authenticated subject.
  need(holderSignatureValid(presentation), "holder_signature_invalid");
  need(await ports.holderBound(request.subject, presentation.holderPublicKey), "holder_not_bound");

  // 6. Proof: hidden values satisfy the pinned criteria, signed by the issuer, watermarked by the request.
  const criteria = criteriaRequestFor(definition, issuer.publicKey, digest, presentation.credential,
    presentation.holderPublicKey);
  const verify = ports.verifyProof ?? verifyCriteria;
  need(await verify(presentation.proof, criteria, ports.proofArtifacts), "proof_invalid");

  // 7. Status: fresh and active at verification time.
  const status = await ports.status({
    credentialIssuer: issuer.id, schema: definition.schema, contentId: presentation.credential.contentId,
  });
  need(status, "status_unavailable");
  const evidence = parseStatusEvidence(status.evidence);
  need(isTime(status.validUntil), "status_unavailable");
  need(evidence.observedAt <= now && now - evidence.observedAt < ports.maxStatusAgeMs, "status_stale");
  need(status.status === "active" && now < status.validUntil, "credential_not_active");

  // 8. Single use. Consumed last so that a failed attempt does not burn a legitimate request.
  need(await ports.consumeRequest(request.id, digest, request.expiresAt), "request_replayed");

  const expiresAt = Math.min(now + ports.resultTtlMs, request.expiresAt, status.validUntil,
    evidence.observedAt + ports.maxStatusAgeMs);
  need(now < expiresAt, "status_stale");
  const result: VerificationResult = {
    schema: VERIFICATION_RESULT_SCHEMA, id: ports.newId(), issuer: ports.verifierId, audience: request.issuer,
    requestId: request.id, requestDigest: digest,
    ...(request.decisionId ? {decisionId: request.decisionId} : {}),
    subject: request.subject, credentialSubject: request.credentialSubject, requirement: request.requirement,
    credentialIssuer: issuer.id,
    status: evidence, issuedAt: now, expiresAt,
  };
  return {result, token: await signVerificationResult(result, ports.resultKey.kid, ports.resultKey.privateKey)};
}
