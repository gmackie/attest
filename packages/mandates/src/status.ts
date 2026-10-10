import {Effect} from "effect";
import {MandateError, demand, documentDigest} from "./protocol.ts";
import type {AgentMandate, LiveStatus, TransactionApproval} from "./protocol.ts";
/**
 * Local reference authority, not a distributed status server. Only the issuer's
 * authenticated service may register/revoke; clients receive read snapshots.
 */
export class LocalStatusRegistry {
  private readonly entries = new Map<string, {digest: string; status: LiveStatus["status"]}>();
  register(document: AgentMandate | TransactionApproval) {
    return Effect.tryPromise({try: async () => {
      const digest = await documentDigest(document), previous = this.entries.get(document.statusRef);
      demand(!previous || previous.digest === digest, "status_ref_already_bound");
      // Retrying issuance cannot reactivate a revoked record.
      if (!previous) this.entries.set(document.statusRef, {digest, status: "active"});
      return digest;
    }, catch: (cause) => cause instanceof MandateError ? cause : new MandateError("status_unavailable")});
  }
  revoke(statusRef: string, status: "revoked" | "superseded" = "revoked") {
    return Effect.try({try: () => {
      const entry = this.entries.get(statusRef); demand(entry, "status_ref_unknown");
      demand(status === "revoked" || status === "superseded", "invalid_status_transition");
      if (entry.status === "active") this.entries.set(statusRef, {...entry, status});
    }, catch: (cause) => cause instanceof MandateError ? cause : new MandateError("status_unavailable")});
  }
  read(statusRef: string, digest: string, now: number, leaseMs = 5000) {
    return Effect.try({try: (): LiveStatus | null => {
      demand(Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(leaseMs) &&
        leaseMs > 0 && leaseMs <= 60000 && Number.isSafeInteger(now + leaseMs), "invalid_status_lease");
      const entry = this.entries.get(statusRef);
      return !entry || entry.digest !== digest ? null : {...entry, observedAt: now, validUntil: now + leaseMs};
    }, catch: (cause) => cause instanceof MandateError ? cause : new MandateError("status_unavailable")});
  }
}
