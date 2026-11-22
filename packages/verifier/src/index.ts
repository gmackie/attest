import {Effect} from "effect";
import {asVerifierError} from "./jws.ts";
import {presentToRequest, type PresentInput} from "./presentation.ts";
import {signProofRequest, verifyProofRequest, type ProofRequest, type RequestVerification} from "./request.ts";
import {verifyVerificationResult, type ResultVerification} from "./result.ts";
import {verifyPresentationForRequest, type PresentationVerifierPorts} from "./verify.ts";

export {VerifierError} from "./jws.ts";
export * from "./request.ts";
export * from "./requirement.ts";
export * from "./presentation.ts";
export * from "./result.ts";
export * from "./verify.ts";

const effect = <A>(run: () => Promise<A>, fallback: string) =>
  Effect.tryPromise({try: run, catch: cause => asVerifierError(cause, fallback)});

/** Effect facades for service boundaries. */
export const issueProofRequest = (request: ProofRequest, kid: string, privateKey: JsonWebKey) =>
  effect(() => signProofRequest(request, kid, privateKey), "request_signing_unavailable");
export const checkProofRequest = (token: string, options: RequestVerification) =>
  effect(() => verifyProofRequest(token, options), "request_verification_unavailable");
export const present = (input: PresentInput) =>
  effect(() => presentToRequest(input), "presentation_unavailable");
export const verifyPresentation = (requestToken: string, presentation: unknown, ports: PresentationVerifierPorts) =>
  effect(() => verifyPresentationForRequest(requestToken, presentation, ports), "verification_unavailable");
export const checkVerificationResult = (token: string, options: ResultVerification) =>
  effect(() => verifyVerificationResult(token, options), "result_verification_unavailable");
export * from "./enrollment.ts";
