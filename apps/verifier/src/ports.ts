/**
 * Production ports for verifyPresentationForRequest, built per verification.
 *
 * The clock is frozen once per verification, and the chain reader uses the same
 * instant, so status evidence is never "observed" after the verifier's own `now`
 * (which would make it look like future, i.e. stale, evidence).
 */
import { resolveAuthority } from "@attest/authority";
import type { ChainEndpoint, ChainStatusReader } from "@attest/chain-evm";
import {
  VerifierError,
  type CredentialStatus, type PresentationVerifierPorts, type SubjectRef,
} from "@attest/verifier";
import type { CriteriaRequest, GpcProofEnvelope } from "@attest/proofs";
import type { Catalog, IssuerPolicy } from "./catalog";
import type { DurableObjectNamespaceLike, VerifierConfig } from "./config";
import {
  anchorStatus, ChainStatusError, issuerGrantActive, snapshotOnce, statusReader,
  type CredentialStatusRegistry,
} from "./chain";

/** Status observations may be at most this old when a result is signed (spec: ≤ 60 s). */
export const MAX_STATUS_AGE_MS = 60_000;
/** Result TTL before the status-lease cap (spec: ≤ 5 min). The lease usually binds first. */
export const RESULT_TTL_MS = 300_000;

export interface PortDeps {
  config: VerifierConfig;
  catalog: Catalog;
  endpoints: () => readonly ChainEndpoint[];
  replay: DurableObjectNamespaceLike;
  enrollments: DurableObjectNamespaceLike;
  credentialStatus: CredentialStatusRegistry;
  now: number;
  newId(): string;
  proofArtifacts?: string;
  verifyProof?: (proof: GpcProofEnvelope, request: CriteriaRequest, artifacts?: string) => Promise<boolean>;
  /** PEP issuer of the request being verified, used only to namespace replay records. */
  requestIssuer: string;
}

const chainFailure = (cause: unknown): never => {
  if (cause instanceof ChainStatusError) throw new VerifierError("chain_unavailable");
  throw cause;
};

function policyFor(catalog: Catalog, requirementId: string, issuerId: string): IssuerPolicy | undefined {
  return catalog.get(requirementId)?.issuers[issuerId];
}

/** Resolve the pinned authority path; returns the earliest grant expiry when authorized. */
function pinnedAuthority(policy: Extract<IssuerPolicy, { authority: "pinned" }>, schema: string, at: number) {
  const resolution = resolveAuthority(policy.graph, {
    issuer: policy.graphIssuer, action: policy.action, predicate: policy.predicate, schema,
    at: new Date(at).toISOString(),
  });
  if (!resolution.authorized) return null;
  const ends = resolution.path.map((g) => (g.validUntil ? Date.parse(g.validUntil) : Number.POSITIVE_INFINITY));
  return { validUntil: Math.min(...ends) };
}

export const holderEnrollmentName = (holderPublicKey: string) => `holder:${holderPublicKey}`;

export async function replayName(issuer: string, requestId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${issuer}\n${requestId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "request:" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildPorts(deps: PortDeps): PresentationVerifierPorts {
  const { config, catalog, now } = deps;
  let reader: ChainStatusReader | undefined;
  let snapshot: (() => ReturnType<ChainStatusReader["snapshot"]>) | undefined;
  const chain = () => {
    reader ??= statusReader(deps.endpoints(), config.finality, () => now);
    snapshot ??= snapshotOnce(reader);
    return { reader, snapshot };
  };
  // The status port does not receive the requirement id; remember it from the authority check.
  let requirementId: string | undefined;

  return {
    verifierId: config.verifierId,
    async resolveRequestKey(issuer, kid) {
      return config.peps.get(issuer)?.get(kid) ?? null;
    },
    async requirement(id) {
      return catalog.get(id)?.definition ?? null;
    },
    async authorizedIssuer(credentialIssuer, reqId, at) {
      requirementId = reqId;
      const entry = catalog.get(reqId);
      const policy = policyFor(catalog, reqId, credentialIssuer);
      if (!entry || !policy) return false;
      if (policy.authority === "pinned") return pinnedAuthority(policy, entry.definition.schema, at) !== null;
      try {
        const { reader, snapshot } = chain();
        return await issuerGrantActive(reader, await snapshot(), policy);
      } catch (e) {
        return chainFailure(e);
      }
    },
    async holderBound(subject: SubjectRef, holderPublicKey: string) {
      const stub = deps.enrollments.get(deps.enrollments.idFromName(holderEnrollmentName(holderPublicKey)));
      const res = await stub.fetch("https://enrollments/binding", { method: "GET" });
      if (!res.ok) throw new VerifierError("enrollment_unavailable");
      const { binding } = (await res.json()) as { binding: { issuer: string; subject: string } | null };
      return binding !== null && binding.issuer === subject.issuer && binding.subject === subject.subject;
    },
    async status(query): Promise<CredentialStatus | null> {
      const policy = requirementId ? policyFor(catalog, requirementId, query.credentialIssuer) : undefined;
      if (!policy) return null;
      if (policy.status === "anchor" && policy.authority === "chain") {
        try {
          const { reader, snapshot } = chain();
          return await anchorStatus(reader, await snapshot(), policy, query.schema, query.contentId);
        } catch (e) {
          return chainFailure(e);
        }
      }
      // Credential-level status source (ATTE-21 seam). None exists yet for pinned issuers.
      const credential = await deps.credentialStatus.lookup(query);
      if (credential) return credential;
      // Issuer-level only: the pinned authority path is active now. This says nothing about
      // revocation of the individual credential; the evidence source is "registry".
      if (policy.authority !== "pinned") return null;
      const authority = pinnedAuthority(policy, query.schema, now);
      if (!authority) return { status: "revoked", validUntil: now, evidence: { source: "registry", observedAt: now } };
      return { status: "active", validUntil: authority.validUntil, evidence: { source: "registry", observedAt: now } };
    },
    async consumeRequest(requestId, digest, expiresAt) {
      const stub = deps.replay.get(deps.replay.idFromName(await replayName(deps.requestIssuer, requestId)));
      const res = await stub.fetch("https://replay/consume", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest, expiresAt, now }),
      });
      if (!res.ok) throw new VerifierError("replay_store_unavailable");
      return ((await res.json()) as { consumed: boolean }).consumed;
    },
    resultKey: { kid: config.activeResultKey.kid, privateKey: config.activeResultKey.privateKey },
    now: () => now,
    maxStatusAgeMs: MAX_STATUS_AGE_MS,
    resultTtlMs: RESULT_TTL_MS,
    newId: deps.newId,
    ...(deps.proofArtifacts === undefined ? {} : { proofArtifacts: deps.proofArtifacts }),
    ...(deps.verifyProof === undefined ? {} : { verifyProof: deps.verifyProof }),
  };
}
