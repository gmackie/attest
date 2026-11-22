/**
 * Holder enrollment: binds a holder POD (EdDSA) key to one authenticated subject.
 *
 * Enrollment requires both:
 *  - an authenticated subject `{iss, sub}` from a verified IdP access token, and
 *  - proof of possession of the holder key: a POD signed by that key whose only entry
 *    is the canonical `attest.holder-enrollment/v1` statement naming the same subject,
 *    this verifier and a timestamp at most five minutes old.
 *
 * A holder key is bound to at most one subject. Rebinding it to another subject is
 * refused (`holder_already_enrolled`), so one key-holder cannot lend presentations to
 * several accounts through this verifier.
 */
import { POD, type JSONPOD } from "@pcd/pod";
import { canonicalJson } from "@attest/mandates/protocol";
import type { SubjectRef } from "@attest/verifier";

export const ENROLLMENT_SCHEMA = "attest.holder-enrollment/v1";
export const MAX_ENROLLMENT_AGE_MS = 300_000;
const FUTURE_SKEW_MS = 30_000;

export interface EnrollmentStatement {
  schema: typeof ENROLLMENT_SCHEMA;
  verifier: string;
  subject: SubjectRef;
  holderPublicKey: string;
  issuedAt: number;
}

export class EnrollmentError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}
const need = (ok: unknown, code: string, status = 400): void => {
  if (!ok) throw new EnrollmentError(code, status);
};

/** Canonical bytes of the statement (the same canonical JSON as attest.* JWS payloads). */
export const canonicalStatement = (s: EnrollmentStatement): string => canonicalJson(s);

/** Wallet side: sign an enrollment statement with the holder key. */
export const signEnrollment = (statement: EnrollmentStatement, holderPrivateKey: string): JSONPOD =>
  POD.sign({ enrollment: { type: "string", value: canonicalStatement(statement) } }, holderPrivateKey).toJSON();

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseStatement(value: unknown): EnrollmentStatement {
  need(isRecord(value), "invalid_enrollment");
  const v = value as Record<string, unknown>;
  need(Object.keys(v).sort().join(",") === "holderPublicKey,issuedAt,schema,subject,verifier", "invalid_enrollment");
  need(v.schema === ENROLLMENT_SCHEMA, "unsupported_enrollment_schema");
  need(typeof v.verifier === "string" && typeof v.holderPublicKey === "string" &&
    v.holderPublicKey.length > 0 && v.holderPublicKey.length <= 256 &&
    Number.isSafeInteger(v.issuedAt) && isRecord(v.subject), "invalid_enrollment");
  const s = v.subject as Record<string, unknown>;
  need(Object.keys(s).sort().join(",") === "issuer,subject" && typeof s.issuer === "string" &&
    typeof s.subject === "string", "invalid_enrollment");
  return {
    schema: ENROLLMENT_SCHEMA, verifier: v.verifier as string, holderPublicKey: v.holderPublicKey as string,
    issuedAt: v.issuedAt as number, subject: { issuer: s.issuer as string, subject: s.subject as string },
  };
}

/**
 * Checks the statement against the authenticated subject, this verifier and the clock,
 * then the holder's proof of possession. Throws EnrollmentError.
 */
export function checkEnrollment(
  body: unknown,
  authenticated: SubjectRef,
  verifierId: string,
  now: number,
): EnrollmentStatement {
  need(isRecord(body) && Object.keys(body).sort().join(",") === "signature,statement", "invalid_enrollment");
  const statement = parseStatement((body as Record<string, unknown>).statement);
  need(statement.verifier === verifierId, "enrollment_audience_mismatch");
  // The subject comes from the token. The statement must name the same one, so a
  // statement signed for one account cannot be replayed under another account's token.
  need(statement.subject.issuer === authenticated.issuer && statement.subject.subject === authenticated.subject,
    "enrollment_subject_mismatch", 403);
  need(statement.issuedAt <= now + FUTURE_SKEW_MS && now - statement.issuedAt <= MAX_ENROLLMENT_AGE_MS,
    "enrollment_stale");
  let valid = false;
  try {
    const pod = POD.fromJSON((body as { signature: JSONPOD }).signature);
    const entries = pod.content.asEntries();
    valid = pod.verifySignature() && pod.signerPublicKey === statement.holderPublicKey &&
      Object.keys(entries).length === 1 && entries.enrollment?.type === "string" &&
      entries.enrollment.value === canonicalStatement(statement);
  } catch {
    valid = false;
  }
  need(valid, "enrollment_signature_invalid");
  return statement;
}

/* ------------------------------------------------------------------------------------------ */

export interface DurableStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
}
export interface DurableState { storage: DurableStorage }

interface Binding { issuer: string; subject: string; enrolledAt: number }
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * One instance per holder public key (idFromName(holderPublicKey)), SQLite-backed.
 * The instance is single-threaded, so the read-then-write below is atomic.
 */
export class EnrollmentStore {
  constructor(private readonly state: DurableState, _env?: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const current = await this.state.storage.get<Binding>("binding");
    if (request.method === "GET" && url.pathname === "/binding") return reply({ binding: current ?? null });
    if (request.method === "PUT" && url.pathname === "/binding") {
      const next = (await request.json()) as Binding;
      if (current && (current.issuer !== next.issuer || current.subject !== next.subject))
        return reply({ code: "holder_already_enrolled" }, 409);
      await this.state.storage.put("binding", { issuer: next.issuer, subject: next.subject,
        enrolledAt: current?.enrolledAt ?? next.enrolledAt });
      return reply({ enrolled: true, existing: Boolean(current) });
    }
    return reply({ code: "not_found" }, 404);
  }
}
