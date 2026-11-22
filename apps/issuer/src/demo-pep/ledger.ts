/**
 * The demo PEP's decision ledger: a salted, hash-chained log of its decisions sealed into
 * RFC 6962 epochs, using Gatekeeper's construction (GATE-12) under the demo PEP's own labels.
 *
 * Callers must serialize access (the DemoPepService Durable Object runs every command in one
 * queue). Epochs are sealed by the hourly alarm, or on demand when a decision's receipt is first
 * asked for. Sealing re-verifies the chain from the last sealed leaf, refuses to seal a damaged
 * span, and stores every leaf's inclusion path, so reading a receipt is O(log n). Leaves and
 * their decision index are kept for RETENTION_MS after their epoch is sealed; epoch rows (root
 * and boundary hashes) are kept. The demo PEP does not publish epochs on-chain.
 */
import {
  decisionCommitment, DEMO_PEP_LEDGER_PROFILE, LEDGER_GENESIS, ledgerLeafHash, merkleAuditPaths, verifyInclusion,
  type DecisionReceipt,
} from "@attest/chain-evm";
import { canonicalJson } from "@attest/mandates/protocol";

export { DEMO_PEP_LEDGER_PROFILE };
/** Bounds one seal's work; anything beyond rolls into the next epoch. */
export const MAX_EPOCH_LEAVES = 1024;
/** Leaves (and so receipts) are kept this long after their epoch is sealed. */
export const RETENTION_MS = 30 * 86_400_000;
/** Epochs one retention pass may drop. */
const MAX_PURGED_EPOCHS = 4;

export interface Store {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Keys with this prefix in ascending order, at most `limit`. */
  list<T = unknown>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(at: number): Promise<void>;
}

/** What a leaf commits to: the decision as enforced. The principal is a pseudonymous digest. */
export interface LedgerDecision {
  schema: string;
  id: string;
  at: number;
  action: string;
  resourceId: string;
  outcome: "allow" | "challenge" | "deny";
  reason: string;
  principalId: string;
  policyRevision: string;
  /** Verifier results this decision relied on (allow), or requested (challenge). No hidden values. */
  evidence: {
    verifier: string;
    requirement: { id: string; digest: string };
    credentialSubject: string;
    requestId: string;
    resultId?: string;
    statusSource?: string;
    expiresAt: number;
  }[];
}
interface LeafRow {
  seq: number; prevHash: string; leafHash: string; salt: string; canonical: string; principalId: string;
  decisionId: string; epoch: number | null; path?: string[];
}
interface Head { seq: number; lastLeafHash: string }
export interface EpochRow {
  epoch: number; root: string; firstSeq: number; lastSeq: number; size: number;
  firstPrevHash: string; lastLeafHash: string; sealedAt: number;
  /** Set once DecisionLogAnchor holds this epoch (see anchor.ts). */
  anchor?: unknown;
  /** The last failed anchoring attempt, as a sanitized code. */
  anchorError?: { code: string; at: number } | null;
}
interface EpochHead { epoch: number; lastSeq: number; lastLeafHash: string }

export class LedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const leafKey = (seq: number) => `ledger:leaf:${seq}`;

export async function appendDecision(store: Store, decision: LedgerDecision): Promise<{ seq: number; leafHash: string }> {
  const head = (await store.get<Head>("ledger:head")) ?? { seq: 0, lastLeafHash: LEDGER_GENESIS };
  const canonical = canonicalJson(decision);
  const salt = hex(crypto.getRandomValues(new Uint8Array(32)));
  const leafHash = await ledgerLeafHash(DEMO_PEP_LEDGER_PROFILE, head.lastLeafHash,
    await decisionCommitment(DEMO_PEP_LEDGER_PROFILE, canonical, salt));
  const seq = head.seq + 1;
  const row: LeafRow = {
    seq, prevHash: head.lastLeafHash, leafHash, salt, canonical, principalId: decision.principalId,
    decisionId: decision.id, epoch: null,
  };
  await store.put(leafKey(seq), row);
  await store.put(`ledger:decision:${decision.id}`, seq);
  await store.put("ledger:head", { seq, lastLeafHash: leafHash } satisfies Head);
  return { seq, leafHash };
}

async function range(store: Store, first: number, last: number): Promise<LeafRow[]> {
  const rows: LeafRow[] = [];
  for (let s = first; s <= last; s++) {
    const row = await store.get<LeafRow>(leafKey(s));
    if (!row) break;
    rows.push(row);
  }
  return rows;
}

/** Seals every leaf after the last epoch (up to MAX_EPOCH_LEAVES). Returns null when nothing is pending. */
export async function sealEpoch(store: Store, now: number): Promise<EpochRow | null> {
  const last = await store.get<EpochHead>("ledger:epoch-head");
  const head = (await store.get<Head>("ledger:head")) ?? { seq: 0, lastLeafHash: LEDGER_GENESIS };
  const firstSeq = (last?.lastSeq ?? 0) + 1;
  if (head.seq < firstSeq) return null;
  const rows = await range(store, firstSeq, Math.min(head.seq, firstSeq + MAX_EPOCH_LEAVES - 1));
  // The predecessor is the hash recorded when the previous epoch was sealed, never the row there now.
  let prev = last ? last.lastLeafHash : LEDGER_GENESIS, expect = firstSeq;
  for (const row of rows) {
    const leaf = await ledgerLeafHash(DEMO_PEP_LEDGER_PROFILE, row.prevHash,
      await decisionCommitment(DEMO_PEP_LEDGER_PROFILE, row.canonical, row.salt));
    if (row.seq !== expect || row.prevHash !== prev || leaf !== row.leafHash) throw new LedgerError("chain_broken");
    prev = row.leafHash;
    expect++;
  }
  if (!rows.length) throw new LedgerError("chain_broken");
  const { root, paths } = await merkleAuditPaths(rows.map((r) => r.leafHash));
  const epoch: EpochRow = {
    epoch: (last?.epoch ?? 0) + 1, root, firstSeq, lastSeq: rows[rows.length - 1]!.seq, size: rows.length,
    firstPrevHash: last ? last.lastLeafHash : LEDGER_GENESIS, lastLeafHash: rows[rows.length - 1]!.leafHash, sealedAt: now,
  };
  await store.put(`ledger:epoch:${epoch.epoch}`, epoch);
  for (const [i, row] of rows.entries()) await store.put(leafKey(row.seq), { ...row, epoch: epoch.epoch, path: paths[i] });
  await store.put("ledger:epoch-head", { epoch: epoch.epoch, lastSeq: epoch.lastSeq, lastLeafHash: epoch.lastLeafHash } satisfies EpochHead);
  return epoch;
}

export const readEpoch = (store: Store, epoch: number) => store.get<EpochRow>(`ledger:epoch:${epoch}`);

/**
 * The receipt for one decision, to the principal it is about only (others learn nothing about
 * whether it exists). Seals pending leaves first if the decision is not yet in an epoch; after
 * that, a read is one leaf, one epoch and an O(log n) check of the stored path.
 */
export async function decisionReceipt(store: Store, decisionId: string, principalId: string, now: number):
  Promise<DecisionReceipt & { epoch: EpochRow & { anchor: unknown } }> {
  const seq = await store.get<number>(`ledger:decision:${decisionId}`);
  let leaf = seq === undefined ? undefined : await store.get<LeafRow>(leafKey(seq));
  if (!leaf || leaf.principalId !== principalId) throw new LedgerError("unknown_decision");
  while (leaf.epoch === null) {
    if (!(await sealEpoch(store, now))) throw new LedgerError("ledger_damaged");
    leaf = (await store.get<LeafRow>(leafKey(leaf.seq)))!;
  }
  const epoch = await readEpoch(store, leaf.epoch);
  if (!epoch || !leaf.path) throw new LedgerError("ledger_damaged");
  const index = leaf.seq - epoch.firstSeq;
  // Never hand out a proof that would not verify.
  if (!(await verifyInclusion(leaf.leafHash, index, epoch.size, leaf.path, epoch.root))) throw new LedgerError("ledger_damaged");
  return {
    schema: DEMO_PEP_LEDGER_PROFILE.proof, decision: JSON.parse(leaf.canonical) as LedgerDecision & Record<string, unknown>,
    salt: leaf.salt, seq: leaf.seq, prevHash: leaf.prevHash, leafHash: leaf.leafHash,
    epoch: { ...epoch, anchor: epoch.anchor ?? null }, leafIndex: index, path: leaf.path,
  };
}

/** Drops leaves and decision indexes of epochs sealed more than RETENTION_MS ago. Epoch rows stay. */
export async function purgeLedger(store: Store, now: number): Promise<number> {
  let next = (await store.get<number>("ledger:retained-from")) ?? 1, purged = 0;
  while (purged < MAX_PURGED_EPOCHS) {
    const epoch = await readEpoch(store, next);
    if (!epoch || now - epoch.sealedAt < RETENTION_MS) break;
    for (let s = epoch.firstSeq; s <= epoch.lastSeq; s++) {
      const row = await store.get<LeafRow>(leafKey(s));
      if (row) await store.delete(`ledger:decision:${row.decisionId}`);
      await store.delete(leafKey(s));
    }
    next++;
    purged++;
    await store.put("ledger:retained-from", next);
  }
  return purged;
}
