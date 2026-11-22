/**
 * Issuer revocation status lists (ATTE-24): per-issuer, per-epoch roots in RevocationRoots, read through
 * ChainStatusReader, plus the issuer-side list builder and verifier-side non-revocation checks.
 *
 * Privacy property, stated exactly: the on-chain read is per issuer list (`latest(list)`), never per
 * credential, so the RPC providers and chain observers never see which credential is being checked. The
 * verifier either downloads the whole epoch list or receives a holder-made non-membership proof, so the issuer
 * (and whoever hosts the list) learns no per-credential query either. The verifier itself does learn the
 * presented credential's revocation identifier; see specs/revocation-roots.md for what each party learns.
 *
 * Hex conventions follow decision-log.ts: identifiers and roots are 64 lowercase hex characters without 0x.
 * The tree is RFC 6962 (SHA-256) over the strictly ascending identifiers.
 */
import { parseAbi, type Address, type Hex } from "viem";
import { inclusionProof, merkleRoot, verifyInclusion } from "./decision-log";
import { ChainStatusError, chainEvidence, type ChainSnapshot, type ChainStatusReader } from "./status";

export const revocationRootsAbi = parseAbi([
  "constructor(address administrator_)",
  "function administrator() view returns (address)",
  "function pendingAdministrator() view returns (address)",
  "function publisher(bytes32) view returns (address)",
  "function latestEpoch(bytes32) view returns (uint64)",
  "function getEpoch(bytes32 list,uint64 epoch) view returns ((bytes32 root,uint64 size,uint64 publishedAt))",
  "function latest(bytes32 list) view returns (uint64 epoch,bytes32 root,uint64 size,uint64 publishedAt)",
  "function proposeAdministrator(address next)",
  "function cancelAdministratorProposal()",
  "function acceptAdministrator()",
  "function setPublisher(bytes32 list,address publisher_)",
  "function publishEpoch(bytes32 list,uint64 epoch,bytes32 root,uint64 size)",
  "event AdministratorProposalCancelled(address indexed current,address indexed proposed)",
  "event EpochPublished(bytes32 indexed list,uint64 indexed epoch,bytes32 root,uint64 size)",
]);

const fail = (code: string, detail?: string): never => { throw new ChainStatusError(code, detail); };
const hex64 = /^[0-9a-f]{64}$/;
const MAX_LIST_SIZE = 2 ** 32;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable on-chain id for an issuer's revocation list, e.g. revocationListId("carrier:northwind"). */
export async function revocationListId(issuer: string): Promise<Hex> {
  if (!issuer || issuer.length > 256) fail("invalid_list_name");
  return `0x${await sha256Hex(`attest.revocation-list/v1\n${issuer}`)}` as Hex;
}

/**
 * Revocation identifier for one credential: SHA-256 over a domain tag, the issuer list, the credential content
 * id and an optional salt. Without a salt, anyone who already knows the content id (the holder, the issuer, and
 * every verifier it was presented to) can test it against the public list. With a salt that only the issuer and
 * holder know, a list downloader cannot map entries back to content ids. The verifier must then obtain the salt
 * from an issuer-signed field of the verified credential (and learns it from then on); a salt or identifier the
 * holder merely asserts is never acceptable, because a fresh one yields an id that is not on the list.
 */
export async function deriveRevocationId(input: { list: Hex; contentId: string; salt?: string }): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.list)) fail("invalid_revocation_input", "list");
  if (!input.contentId || input.contentId.length > 256 || input.contentId.includes("\n")) fail("invalid_revocation_input", "contentId");
  if (input.salt !== undefined && !/^[0-9a-f]{32,128}$/.test(input.salt)) fail("invalid_revocation_input", "salt");
  return sha256Hex(`attest.revocation-id/v1\n${input.list.toLowerCase()}\n${input.contentId}\n${input.salt ?? ""}`);
}

/** A complete revocation list for one epoch, as the issuer publishes it off-chain. */
export interface RevocationList {
  /** Strictly ascending revocation identifiers. */
  ids: readonly string[];
  root: string;
  size: number;
}

/** Issuer side: canonicalize (sort, de-duplicate) identifiers and compute the root to publish. */
export async function buildRevocationList(ids: Iterable<string>): Promise<RevocationList> {
  const unique = [...new Set(ids)];
  if (!unique.every((id) => hex64.test(id))) fail("invalid_revocation_id");
  if (unique.length > MAX_LIST_SIZE) fail("revocation_list_too_large");
  unique.sort();
  return { ids: unique, root: await merkleRoot(unique), size: unique.length };
}

/** Verifier side: a downloaded list must be canonical and reproduce the on-chain root and size exactly. */
export async function verifyRevocationList(ids: readonly string[], committed: { root: string; size: number }): Promise<boolean> {
  if (ids.length !== committed.size || !hex64.test(committed.root)) return false;
  for (let i = 0; i < ids.length; i++) {
    if (!hex64.test(ids[i]!)) return false;
    if (i > 0 && !(ids[i - 1]! < ids[i]!)) return false;
  }
  return (await merkleRoot(ids)) === committed.root;
}

interface Neighbor { index: number; id: string; path: readonly string[] }
/**
 * Non-membership of `id` in a sorted tree: the adjacent leaves around where it would sit, each with an
 * inclusion path. `low` is absent when the id sorts before every entry, `high` when it sorts after every entry,
 * both when the list is empty. Valid only for the epoch it names.
 */
export interface NonMembershipProof {
  epoch: number;
  low?: Neighbor;
  high?: Neighbor;
}

/** Holder (or verifier) side, from a downloaded list. Returns null when the id IS revoked. */
export async function nonMembershipProof(list: RevocationList, epoch: number, id: string): Promise<NonMembershipProof | null> {
  if (!hex64.test(id)) fail("invalid_revocation_id");
  let lo = 0, hi = list.ids.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list.ids[mid]! < id) lo = mid + 1; else hi = mid; }
  if (list.ids[lo] === id) return null;
  const neighbor = async (index: number): Promise<Neighbor> =>
    ({ index, id: list.ids[index]!, path: await inclusionProof(list.ids, index) });
  return {
    epoch,
    ...(lo > 0 ? { low: await neighbor(lo - 1) } : {}),
    ...(lo < list.ids.length ? { high: await neighbor(lo) } : {}),
  };
}

/**
 * Check a non-membership proof against a committed root and size (always taken from chain, never from the
 * proof). Soundness relies on the issuer having committed to a sorted list; a verifier that downloads the list
 * checks that with verifyRevocationList instead.
 */
export async function verifyNonMembership(id: string, proof: NonMembershipProof, committed: { root: string; size: number }): Promise<boolean> {
  const { size, root } = committed;
  if (!hex64.test(id) || !hex64.test(root) || !Number.isSafeInteger(size) || size < 0) return false;
  const { low, high } = proof;
  if (size === 0) return !low && !high && root === (await merkleRoot([]));
  if (!low && !high) return false;
  if (low && !(hex64.test(low.id) && low.id < id)) return false;
  if (high && !(hex64.test(high.id) && id < high.id)) return false;
  if (low && high && high.index !== low.index + 1) return false;
  if (!low && high!.index !== 0) return false;
  if (!high && low!.index !== size - 1) return false;
  for (const n of [low, high]) if (n && !(Array.isArray(n.path) && await verifyInclusion(n.id, n.index, size, n.path, root))) return false;
  return true;
}

/** An epoch as read from chain at a settled block. */
export interface RevocationEpoch {
  epoch: number;
  root: string;
  size: number;
  /** Publication block time, ms. */
  publishedAt: number;
  evidence: ReturnType<typeof chainEvidence>;
}

/** The latest epoch of an issuer list at a settled block (two agreeing RPCs, reorg-checked). Null if none. */
export async function readRevocationEpoch(
  reader: ChainStatusReader,
  query: { address: Address; list: Hex },
  snapshot?: ChainSnapshot,
): Promise<RevocationEpoch | null> {
  const at = snapshot ?? (await reader.snapshot());
  const [epoch, root, size, publishedAt] = (await reader.read(at, (client, blockNumber) =>
    client.readContract({ address: query.address, abi: revocationRootsAbi, functionName: "latest", args: [query.list], blockNumber }),
  )) as [bigint, Hex, bigint, bigint];
  if (epoch === 0n) return null;
  if (size > BigInt(MAX_LIST_SIZE)) fail("revocation_list_too_large");
  return { epoch: Number(epoch), root: root.slice(2).toLowerCase(), size: Number(size), publishedAt: Number(publishedAt) * 1000,
    evidence: chainEvidence(at) };
}

/** What the verifier checks non-revocation with: the whole epoch list, or a holder's non-membership proof. */
export type NonRevocationEvidence =
  | { kind: "list"; ids: readonly string[] }
  | { kind: "proof"; proof: NonMembershipProof };

/**
 * The credential being checked, as the verifier has already verified it. The revocation id is always derived
 * here from these fields; callers cannot pass an id. A holder-chosen id or salt would let a revoked holder
 * present an identifier that is simply not on the list, so:
 * - `contentId` must be the content id the verified proof is bound to (the issuer's signature covers it);
 * - `issuerSignedSalt` must come from an issuer-signed field of that credential (for example a POD entry the
 *   proof reveals, or an issuer-signed salt record bound to this content id and checked against the issuer's
 *   key), never from holder-asserted presentation material, request parameters or any holder-controlled channel.
 */
export interface VerifiedCredential {
  contentId: string;
  issuerSignedSalt?: string;
}

export interface RevocationStatusQuery {
  address: Address;
  list: Hex;
  credential: VerifiedCredential;
  /** Maximum age of the latest epoch, measured from its publication to the observation time. */
  maxEpochAgeMs: number;
  /** Credential validity end (ms), if known; the result's validUntil never exceeds it. */
  credentialValidUntil?: number;
  /**
   * Called with the epoch read from chain and the derived revocation id, so a list or proof is fetched for exactly
   * that epoch and id. A holder proof is checked against the derived id, never against an id inside the proof.
   */
  evidence(epoch: RevocationEpoch, revocationId: string): Promise<NonRevocationEvidence>;
}

/** Structurally @attest/verifier's CredentialStatus, plus the epoch it was checked against. */
export type RevocationStatus = {
  status: "active" | "revoked";
  reason?: "listed_revoked";
  /** min(epoch publication + max age, credential validity), ms: a status lease, never longer than the root's freshness. */
  validUntil: number;
  epoch: number;
  evidence: ReturnType<typeof chainEvidence>;
};

/**
 * Non-revocation status of one credential against its issuer's latest epoch. Returns null when the issuer has
 * never published. Throws (fail closed) on chain inconsistency, a stale root (`revocation_root_stale`), a list
 * that does not match the root (`revocation_list_mismatch`), a proof for another epoch
 * (`revocation_epoch_mismatch`) or a proof that does not verify (`revocation_proof_invalid`).
 */
export async function revocationStatus(
  reader: ChainStatusReader,
  query: RevocationStatusQuery,
  snapshot?: ChainSnapshot,
): Promise<RevocationStatus | null> {
  if (!Number.isSafeInteger(query.maxEpochAgeMs) || query.maxEpochAgeMs <= 0) fail("invalid_revocation_query", "maxEpochAgeMs");
  const revocationId = await deriveRevocationId({ list: query.list, contentId: query.credential.contentId,
    ...(query.credential.issuerSignedSalt === undefined ? {} : { salt: query.credential.issuerSignedSalt }) });
  const at = snapshot ?? (await reader.snapshot());
  const epoch = await readRevocationEpoch(reader, { address: query.address, list: query.list }, at);
  if (!epoch) return null;
  const freshUntil = epoch.publishedAt + query.maxEpochAgeMs;
  if (at.observedAt >= freshUntil) fail("revocation_root_stale", `epoch ${epoch.epoch}`);
  const validUntil = Math.min(freshUntil, query.credentialValidUntil ?? Number.MAX_SAFE_INTEGER);
  const base = { validUntil, epoch: epoch.epoch, evidence: epoch.evidence };
  const evidence = await query.evidence(epoch, revocationId);
  if (evidence.kind === "list") {
    if (!(await verifyRevocationList(evidence.ids, epoch))) fail("revocation_list_mismatch", `epoch ${epoch.epoch}`);
    let lo = 0, hi = evidence.ids.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (evidence.ids[mid]! < revocationId) lo = mid + 1; else hi = mid; }
    return evidence.ids[lo] === revocationId ? { status: "revoked", reason: "listed_revoked", ...base } : { status: "active", ...base };
  }
  if (evidence.proof.epoch !== epoch.epoch) fail("revocation_epoch_mismatch", `proof ${evidence.proof.epoch}, chain ${epoch.epoch}`);
  if (!(await verifyNonMembership(revocationId, evidence.proof, epoch))) fail("revocation_proof_invalid");
  return { status: "active", ...base };
}

/**
 * A @attest/verifier `status` port backed by revocation roots. Any failure (RPC disagreement, reorg, stale root,
 * bad list or proof, unknown issuer, missing issuer-signed salt) yields null, which the verifier reports as
 * `status_unavailable`: never active.
 *
 * The port only ever sees fields @attest/verifier has verified before calling it: the authorized credential
 * issuer, the pinned schema and the proof-bound content id. The revocation id is derived from those, so nothing
 * the holder asserts can choose it.
 */
export function revocationStatusPort(options: {
  reader: ChainStatusReader;
  address: Address;
  maxEpochAgeMs: number;
  /** The issuer's list id, or null if this verifier does not track one for that issuer. */
  listFor(credentialIssuer: string): Promise<Hex | null>;
  /**
   * Set when this issuer list uses salted revocation ids. Receives only verified fields and must return the salt
   * from an issuer-signed field of that credential (see VerifiedCredential), or null if none is available, which
   * fails closed. Never source it from the holder's presentation or any holder-controlled channel. Without this
   * option ids are unsalted; a list must not mix salted and unsalted ids.
   */
  issuerSignedSalt?(verified: { credentialIssuer: string; schema: string; contentId: string; list: Hex }): Promise<string | null>;
  evidence(query: { credentialIssuer: string; contentId: string; revocationId: string }, epoch: RevocationEpoch): Promise<NonRevocationEvidence>;
  onError?(error: unknown): void;
}) {
  return async (query: { credentialIssuer: string; schema: string; contentId: string }): Promise<RevocationStatus | null> => {
    try {
      const list = await options.listFor(query.credentialIssuer);
      if (!list) return null;
      const verified = { credentialIssuer: query.credentialIssuer, schema: query.schema, contentId: query.contentId, list };
      let credential: VerifiedCredential = { contentId: query.contentId };
      if (options.issuerSignedSalt) {
        const salt = await options.issuerSignedSalt(verified);
        if (salt === null) fail("revocation_salt_unavailable");
        credential = { contentId: query.contentId, issuerSignedSalt: salt! };
      }
      return await revocationStatus(options.reader, {
        address: options.address, list, credential, maxEpochAgeMs: options.maxEpochAgeMs,
        evidence: (epoch, revocationId) =>
          options.evidence({ credentialIssuer: query.credentialIssuer, contentId: query.contentId, revocationId }, epoch),
      });
    } catch (error) {
      options.onError?.(error);
      return null;
    }
  };
}

/** Minimal clients the issuer-side publisher needs (viem PublicClient / WalletClient satisfy these via viemRevocationClients). */
export interface RevocationPublisherClients {
  /** The chain the issuer intends to write to. */
  chainId: number;
  /** The chain the connected RPC actually serves; checked before every write. */
  getChainId(): Promise<number>;
  read(args: { address: Address; functionName: "latestEpoch" | "getEpoch"; args: readonly unknown[] }): Promise<unknown>;
  simulateAndWrite(args: { address: Address; functionName: "publishEpoch"; args: readonly unknown[] }): Promise<Hex>;
  waitForReceipt(hash: Hex, confirmations: number): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}

export function publishEpochArgs(list: Hex, epoch: number, revocations: RevocationList) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) fail("invalid_epoch", "epoch");
  if (!hex64.test(revocations.root) || revocations.size !== revocations.ids.length) fail("invalid_epoch", "list");
  return [list, BigInt(epoch), `0x${revocations.root}` as Hex, BigInt(revocations.size)] as const;
}

/**
 * Issuer-side publisher. Idempotent for an epoch already published with the same root and size; refuses a
 * different commitment for a published epoch (`epoch_conflict`) or a skipped epoch (`epoch_out_of_order`).
 * Mainnet is refused while production writes are gated (specs/production-readiness.md): both the declared chain
 * and, before every write, the chain the RPC actually reports (`chain_mismatch` if they differ).
 */
export function revocationRootsPublisher(options: { clients: RevocationPublisherClients; address: Address; list: Hex; confirmations?: number }) {
  const { clients, address, list } = options;
  const confirmations = options.confirmations ?? 2;
  if (clients.chainId === 1) fail("production_writes_disabled");
  return {
    async publish(epoch: number, revocations: RevocationList): Promise<{ epoch: number; tx?: Hex }> {
      const args = publishEpochArgs(list, epoch, revocations);
      const latest = Number(await clients.read({ address, functionName: "latestEpoch", args: [list] }));
      if (latest >= epoch) {
        const existing = (await clients.read({ address, functionName: "getEpoch", args: [list, BigInt(epoch)] })) as { root: Hex; size: bigint };
        if (existing.root.slice(2).toLowerCase() !== revocations.root || Number(existing.size) !== revocations.size)
          fail("epoch_conflict", `epoch ${epoch}`);
        return { epoch };
      }
      if (latest + 1 !== epoch) fail("epoch_out_of_order", `chain at ${latest}, epoch ${epoch}`);
      await assertWriteChain(clients);
      const tx = await clients.simulateAndWrite({ address, functionName: "publishEpoch", args });
      const receipt = await clients.waitForReceipt(tx, confirmations);
      if (receipt.status !== "success") fail("epoch_reverted", tx);
      return { epoch, tx };
    },
  };
}

async function assertWriteChain(clients: { chainId: number; getChainId(): Promise<number> }) {
  const actual = await clients.getChainId();
  if (actual === 1 || clients.chainId === 1) fail("production_writes_disabled");
  if (actual !== clients.chainId) fail("chain_mismatch", `declared ${clients.chainId}, connected ${actual}`);
}

/** Adapt viem clients for the publisher (keeps viem generics out of callers). */
export function viemRevocationClients(publicClient: {
  getChainId(): Promise<number>;
  readContract(args: never): Promise<unknown>;
  simulateContract(args: never): Promise<{ request: unknown }>;
  waitForTransactionReceipt(args: never): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}, walletClient: { writeContract(args: never): Promise<Hex> }, account: Address, chainId: number): RevocationPublisherClients {
  const clients: RevocationPublisherClients = {
    chainId,
    getChainId: () => publicClient.getChainId(),
    read: (a) => publicClient.readContract({ ...a, abi: revocationRootsAbi } as never),
    simulateAndWrite: async (a) => {
      // Re-checked here too, so the adapter is safe when used without revocationRootsPublisher.
      await assertWriteChain(clients);
      const sim = await publicClient.simulateContract({ ...a, abi: revocationRootsAbi, account } as never);
      return walletClient.writeContract(sim.request as never);
    },
    waitForReceipt: (hash, confirmations) => publicClient.waitForTransactionReceipt({ hash, confirmations } as never),
  };
  return clients;
}
