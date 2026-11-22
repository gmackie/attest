/**
 * attest.presentation/v1 — what a holder returns for a proof request: a GPC
 * proof whose watermark is the request digest, plus an EdDSA (POD) signature by
 * the holder key over the whole presentation (proof of possession).
 */
import {decodePublicKey, deriveSignerPublicKey, encodePublicKey, POD} from "@pcd/pod";
import {proveCriteria, type CriteriaRequest, type GpcProofEnvelope, type SerializedPod} from "@attest/proofs";
import {canonical, isDigest, isRecord, isText, need, shape} from "./jws.ts";
import {requestDigest, type ProofRequest} from "./request.ts";
import {requirementDigest, type RequirementDefinition} from "./requirement.ts";

export const PRESENTATION_SCHEMA = "attest.presentation/v1";

export interface PresentedCredential {
  /** Accepted-issuer identifier from the requirement definition. */
  issuer: string;
  /** Credential subject bound inside the signed POD (for example a supplier identifier). */
  subject: string;
  /** POD content ID, revealed to the verifier only, for the status lookup. */
  contentId: string;
}
export interface Presentation {
  schema: typeof PRESENTATION_SCHEMA;
  requestDigest: string;
  credential: PresentedCredential;
  holderPublicKey: string;
  proof: GpcProofEnvelope;
  holderSignature: SerializedPod;
}
export type UnsignedPresentation = Omit<Presentation, "holderSignature">;

/**
 * @pcd/pod accepts one EdDSA key in several encodings (unpadded or padded base64, hex in any
 * case). Keys used as identifiers (enrollment, holder binding) must have exactly one spelling:
 * the canonical form is encodePublicKey(decodePublicKey(k)), unpadded base64.
 */
export function canonicalPublicKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0 || key.length > 256) return null;
  try {return encodePublicKey(decodePublicKey(key));} catch {return null;}
}
export const isCanonicalPublicKey = (key: unknown): key is string => canonicalPublicKey(key) === key;

export function parsePresentation(value: unknown): Presentation {
  shape(value, ["schema", "requestDigest", "credential", "holderPublicKey", "proof", "holderSignature"]);
  need(value.schema === PRESENTATION_SCHEMA, "unsupported_presentation_schema");
  need(isDigest(value.requestDigest) && isText(value.holderPublicKey, 256), "invalid_presentation");
  need(isCanonicalPublicKey(value.holderPublicKey), "noncanonical_holder_key");
  shape(value.credential, ["issuer", "subject", "contentId"]);
  need(isText(value.credential.issuer, 256) && isText(value.credential.subject, 512) &&
    typeof value.credential.contentId === "string" && /^[0-9]{1,80}$/.test(value.credential.contentId),
    "invalid_presentation");
  need(isRecord(value.proof) && isRecord(value.holderSignature), "invalid_presentation");
  return structuredClone(value) as unknown as Presentation;
}

/** The exact GPC request both prover and verifier derive. Criteria come only from the pinned definition. */
export function criteriaRequestFor(definition: RequirementDefinition, issuerPublicKey: string, digest: string,
  credential: PresentedCredential, holderPublicKey: string): CriteriaRequest {
  return {
    contentID: credential.contentId, schema: definition.schema, subject: credential.subject,
    holderPublicKey, issuerPublicKey, challenge: digest, criteria: definition.criteria,
  };
}

/** The exact bytes the holder signs. */
export const canonicalPresentationBody = (p: UnsignedPresentation): string => canonical(p);
const signedBody = canonicalPresentationBody;

export interface PresentInput {
  /** A request the wallet has already verified and the holder has consented to. */
  request: ProofRequest;
  definition: RequirementDefinition;
  credential: POD;
  credentialIssuer: string;
  credentialSubject: string;
  holderPrivateKey: string;
  artifacts?: string;
}
/** Holder side. Fails (throws) if the hidden values do not satisfy the requirement. */
export async function presentToRequest(input: PresentInput): Promise<Presentation> {
  need(await requirementDigest(input.definition) === input.request.requirement.digest &&
    input.definition.id === input.request.requirement.id, "requirement_mismatch");
  need(input.credentialSubject === input.request.credentialSubject, "credential_subject_mismatch");
  const issuer = input.definition.acceptedIssuers.find(i => i.id === input.credentialIssuer);
  need(issuer && input.credential.signerPublicKey === issuer.publicKey, "unaccepted_credential_issuer");
  const holderPublicKey = deriveSignerPublicKey(input.holderPrivateKey);
  const digest = await requestDigest(input.request);
  const credential = {issuer: issuer.id, subject: input.credentialSubject, contentId: input.credential.contentID.toString()};
  const proof = await proveCriteria(input.credential,
    criteriaRequestFor(input.definition, issuer.publicKey, digest, credential, holderPublicKey), input.artifacts);
  const unsigned: UnsignedPresentation = {schema: PRESENTATION_SCHEMA, requestDigest: digest, credential, holderPublicKey, proof};
  const holderSignature = POD.sign({presentation: {type: "string", value: signedBody(unsigned)}},
    input.holderPrivateKey).toJSON();
  return {...unsigned, holderSignature};
}

/** Proof of possession of the holder key over the entire presentation. */
export function holderSignatureValid(p: Presentation): boolean {
  try {
    const signed = POD.fromJSON(p.holderSignature), {holderSignature: _, ...unsigned} = p;
    const entries = signed.content.asEntries();
    return signed.verifySignature() && signed.signerPublicKey === p.holderPublicKey &&
      Object.keys(entries).length === 1 && entries.presentation?.type === "string" &&
      entries.presentation.value === signedBody(unsigned);
  } catch {
    return false;
  }
}
