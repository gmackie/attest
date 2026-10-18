/**
 * Strict composition of issuer-verified OAuth facts AND an independently
 * verified Attest mandate chain. This does not issue OAuth authority.
 *
 * Call the real OAuth JWT / RFC 7662 / DPoP verifier first, and call
 * verifyMandateChain or verifyPresentation first. Then call this function.
 * Gatekeeper ABAC and atomic budget/approval checks STILL follow.
 */
import {assertMandateContext,demand,type OperationContext,type VerifiedMandateChain} from "./protocol.ts";

export interface VerifiedOAuthAgentGrant {
  readonly tokenType:"access-token";
  /** Exact, operator-reviewed AS issuer identifier. */
  readonly issuer:string;
  /** Represented OAuth user, issuer-qualified by the caller's trusted resolver. */
  readonly subject:string;
  /** Current PIP-authoritative tenant membership; not a user-supplied header. */
  readonly tenant:string;
  /** RFC 8707 target resource identifier. */
  readonly audience:string;
  /** Verified OAuth client_id. */
  readonly clientId:string;
  /** Sender key from fully verified RFC 9449 DPoP proof or other approved PoP. */
  readonly holderKeyThumbprint:string;
  readonly scopes:readonly string[];
  readonly expiresAt:number;
}
export interface OAuthMandateRequirement {
  readonly issuer:string;
  /** All scopes are required; none can be created by the mandate. */
  readonly scopes:readonly string[];
}

/** No "allow" return: this checks ONLY the OAuth ∩ mandate constraints. */
export function assertOAuthMandateIntersection(
  grant:VerifiedOAuthAgentGrant,
  mandate:VerifiedMandateChain,
  operation:OperationContext,
  requirement:OAuthMandateRequirement,
  now:number,
):void {
  // Existing verified-chain logic also checks every ancestor's terms,
  // monetary per-action ceiling, resource, purpose, agent, and validity.
  assertMandateContext(mandate,operation,now);
  demand(grant!==null && typeof grant==="object" &&
    grant.tokenType==="access-token" &&
    grant.issuer===requirement.issuer && grant.subject===operation.subject &&
    grant.tenant===operation.tenant && grant.audience===operation.audience &&
    grant.clientId===operation.actor.clientId &&
    grant.holderKeyThumbprint===operation.actor.keyThumbprint &&
    Number.isSafeInteger(grant.expiresAt) && grant.expiresAt>now,
    "oauth_mandate_binding_denied");
  demand(Array.isArray(requirement.scopes) && requirement.scopes.length>0 &&
    requirement.scopes.length<=64 && new Set(requirement.scopes).size===requirement.scopes.length &&
    requirement.scopes.every(s=>typeof s==="string" && s.length>0 && s.length<=128) &&
    Array.isArray(grant.scopes) && grant.scopes.length<=256 &&
    requirement.scopes.every(s=>grant.scopes.includes(s)),
    "oauth_mandate_scope_denied");
}
