/**
 * attest.holder-enrollment/v1 — the wallet side of holder enrollment: a statement
 * binding a holder POD (EdDSA) key to an authenticated subject at one verifier,
 * signed by the holder key as proof of possession. The verifier checks it together
 * with an IdP access token (apps/verifier/src/enrollment.ts).
 */
import {POD, type JSONPOD} from "@pcd/pod";
import {canonicalJson} from "@attest/mandates/protocol";
import type {SubjectRef} from "./request.ts";

export const ENROLLMENT_SCHEMA = "attest.holder-enrollment/v1";

export interface EnrollmentStatement {
  schema: typeof ENROLLMENT_SCHEMA;
  verifier: string;
  subject: SubjectRef;
  holderPublicKey: string;
  issuedAt: number;
}

/** Canonical bytes of the statement (the same canonical JSON as attest.* JWS payloads). */
export const canonicalStatement = (s: EnrollmentStatement): string => canonicalJson(s);

/** Wallet side: sign an enrollment statement with the holder key. */
export const signEnrollment = (statement: EnrollmentStatement, holderPrivateKey: string): JSONPOD =>
  POD.sign({enrollment: {type: "string", value: canonicalStatement(statement)}}, holderPrivateKey).toJSON();
