/**
 * Decision receipts for hash-chained decision ledgers (Gatekeeper's construction, GATE-12):
 *
 *   commitment = SHA-256(<decision schema> "\n" salt "\n" canonical(decision))
 *   leaf       = SHA-256(<leaf label> "\n" prev "\n" commitment)
 *
 * `prev` is the previous leaf (64 zeros for the first). The per-leaf random salt makes the
 * commitment hiding, so an anchored root or a shown leaf does not confirm a guessed decision.
 * Leaves are sealed into epochs whose RFC 6962 root can be anchored with DecisionLogAnchor.
 *
 * The labels are a profile: Gatekeeper's ledger uses `gatekeeper.*`; other enforcement points
 * (for example the attest demo PEP) use their own, so a receipt never claims to be from a PEP
 * it is not. `verifyDecisionReceipt` needs only this file, decision-log.ts and canonical JSON.
 */
import { canonicalJson, sha256 } from "@attest/mandates/protocol";
import { verifyInclusion } from "./decision-log";

export interface DecisionLedgerProfile {
  /** Decision `schema` value and commitment domain separator. */
  decision: string;
  /** Leaf domain separator. */
  leaf: string;
  /** Proof bundle `schema` value. */
  proof: string;
}
export const GATEKEEPER_LEDGER_PROFILE: DecisionLedgerProfile = {
  decision: "gatekeeper.decision/v1",
  leaf: "gatekeeper.leaf/v1",
  proof: "gatekeeper.decision-proof/v1",
};
/** The attest demo PEP's ledger (apps/issuer, ATTE-20): same construction, its own labels. */
export const DEMO_PEP_LEDGER_PROFILE: DecisionLedgerProfile = {
  decision: "attest.demo-pep.decision/v1",
  leaf: "attest.demo-pep.leaf/v1",
  proof: "attest.demo-pep.decision-proof/v1",
};
export const LEDGER_GENESIS = "0".repeat(64);

export const decisionCommitment = (profile: DecisionLedgerProfile, canonical: string, salt: string): Promise<string> =>
  sha256(`${profile.decision}\n${salt}\n${canonical}`);
export const ledgerLeafHash = (profile: DecisionLedgerProfile, prev: string, commitment: string): Promise<string> =>
  sha256(`${profile.leaf}\n${prev}\n${commitment}`);

/** A sealed decision's inclusion proof, as handed to the decision's principal or a third party. */
export interface DecisionReceipt {
  schema: string;
  decision: { schema: string; id: string } & Record<string, unknown>;
  /** Revealing the salt opens this one commitment; other leaves stay hidden. */
  salt: string;
  seq: number;
  prevHash: string;
  leafHash: string;
  epoch: { epoch: number; firstSeq: number; lastSeq: number; size: number; root: string; anchor: unknown };
  leafIndex: number;
  path: readonly string[];
}
export type ReceiptCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "commitment_mismatch" | "not_included" | "root_mismatch" };

/** The anchored epoch (or just its root) obtained independently of the receipt, e.g. readAnchoredEpoch. */
export type TrustedEpoch = string | { epoch: number; root: string; firstSeq: number; lastSeq: number; size: number };

const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hex64 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/**
 * Recomputes the commitment and leaf from the revealed decision and salt, then checks inclusion.
 * Without `trusted` this only shows the receipt is internally consistent; pass what was read from
 * the anchor to show the operator cannot later deny or alter it. An audit path alone does not fix
 * the tree size, so prefer the whole anchored epoch to a bare root.
 */
export async function verifyDecisionReceipt(
  profile: DecisionLedgerProfile,
  receipt: DecisionReceipt,
  trusted?: TrustedEpoch,
): Promise<ReceiptCheck> {
  const r = receipt as Partial<DecisionReceipt> | null;
  const e = r?.epoch;
  if (!r || r.schema !== profile.proof || !r.decision || r.decision.schema !== profile.decision || !hex64(r.salt) ||
    !int(r.seq) || !e || ![e.epoch, e.firstSeq, e.lastSeq, e.size, r.leafIndex].every(int) ||
    ![r.prevHash, r.leafHash, e.root].every(hex64) || r.leafIndex !== r.seq - e.firstSeq ||
    e.size !== e.lastSeq - e.firstSeq + 1 || !Array.isArray(r.path))
    return { ok: false, reason: "malformed" };
  let canonical: string;
  try {
    canonical = canonicalJson(r.decision);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (await ledgerLeafHash(profile, r.prevHash!, await decisionCommitment(profile, canonical, r.salt!)) !== r.leafHash)
    return { ok: false, reason: "commitment_mismatch" };
  if (!(await verifyInclusion(r.leafHash!, r.leafIndex!, e.size, r.path, e.root)))
    return { ok: false, reason: "not_included" };
  if (trusted !== undefined) {
    const t = typeof trusted === "string" ? { root: trusted } : trusted;
    if (t.root !== e.root) return { ok: false, reason: "root_mismatch" };
    if (typeof trusted === "object" && (trusted.epoch !== e.epoch || trusted.firstSeq !== e.firstSeq ||
      trusted.lastSeq !== e.lastSeq || trusted.size !== e.size))
      return { ok: false, reason: "root_mismatch" };
  }
  return { ok: true };
}
