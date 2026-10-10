import {Effect} from "effect";
import {MandateError, signDocument, verifyMandateChain, verifyTransactionApproval} from "./protocol.ts";
import type {AgentMandate, TransactionApproval, VerificationPorts} from "./protocol.ts";
export * from "./protocol.ts";
export * from "./status.ts";
const failure = (cause: unknown): MandateError =>
  cause instanceof MandateError ? cause : new MandateError("mandate_verification_unavailable");
export const issueMandate = (value: AgentMandate, keyId: string, key: JsonWebKey) =>
  Effect.tryPromise({try: () => signDocument(value, keyId, key), catch: failure});
export const issueTransactionApproval = (value: TransactionApproval, keyId: string, key: JsonWebKey) =>
  Effect.tryPromise({try: () => signDocument(value, keyId, key), catch: failure});
export const verifyPresentation = (tokens: readonly string[], ports: VerificationPorts) =>
  Effect.tryPromise({try: () => verifyMandateChain(tokens, ports), catch: failure});
export const verifyApproval = (token: string, expected: Parameters<typeof verifyTransactionApproval>[1], ports: VerificationPorts) =>
  Effect.tryPromise({try: () => verifyTransactionApproval(token, expected, ports), catch: failure});
