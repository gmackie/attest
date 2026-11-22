/**
 * DecisionLogAnchor client: publish sealed decision-log epochs on-chain and read them back
 * through ChainStatusReader, plus RFC 6962 / RFC 9162 inclusion checking so a third party
 * can verify a decision receipt against the anchored root without trusting the log operator.
 *
 * Hex conventions follow Gatekeeper's ledger: roots and leaf hashes are 64 lowercase hex
 * characters without 0x; the genesis predecessor is 64 zeros (bytes32(0) on-chain).
 */
import { parseAbi, type Address, type Hex } from "viem";
import { ChainStatusError, chainEvidence, type ChainSnapshot, type ChainStatusReader } from "./status";
import { assertWritable } from "./networks";

export const decisionLogAnchorAbi = parseAbi([
  "constructor(address administrator_)",
  "function administrator() view returns (address)",
  "function pendingAdministrator() view returns (address)",
  "function publisher(bytes32) view returns (address)",
  "function latestEpoch(bytes32) view returns (uint64)",
  "function getEpoch(bytes32 log,uint64 epoch) view returns ((bytes32 root,uint64 firstSeq,uint64 lastSeq,bytes32 firstPrevHash,bytes32 lastLeafHash,uint64 anchoredAt))",
  "function proposeAdministrator(address next)",
  "function acceptAdministrator()",
  "function setPublisher(bytes32 log,address publisher_)",
  "function anchorEpoch(bytes32 log,uint64 epoch,bytes32 root,uint64 firstSeq,uint64 lastSeq,bytes32 firstPrevHash,bytes32 lastLeafHash)",
  "event EpochAnchored(bytes32 indexed log,uint64 indexed epoch,bytes32 root,uint64 firstSeq,uint64 lastSeq,bytes32 lastLeafHash)",
]);

const fail = (code: string, detail?: string): never => { throw new ChainStatusError(code, detail); };
const hex64 = /^[0-9a-f]{64}$/;
const toBytes32 = (value: string, field: string): Hex => {
  if (!hex64.test(value)) fail("invalid_epoch", field);
  return `0x${value}` as Hex;
};
const fromBytes32 = (value: Hex): string => value.slice(2).toLowerCase();
const seq = (value: number, field: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_epoch", field);
  return BigInt(value);
};

/** A sealed epoch as Gatekeeper's ledger produces it (EpochRoot plus its boundary hashes). */
export interface SealedEpoch {
  epoch: number;
  root: string;
  firstSeq: number;
  lastSeq: number;
  size: number;
  /** Predecessor of the first leaf: the previous epoch's last leaf, or 64 zeros for epoch 1. */
  firstPrevHash: string;
  lastLeafHash: string;
}
/** What a verifier compares a proof against: Gatekeeper's `AnchoredEpoch`, read from chain. */
export interface AnchoredEpoch {
  epoch: number;
  root: string;
  firstSeq: number;
  lastSeq: number;
  size: number;
  firstPrevHash: string;
  lastLeafHash: string;
  anchoredAt: number;
  evidence: ReturnType<typeof chainEvidence>;
}

/** Stable on-chain id for a log, e.g. logId("gatekeeper.gmac.io/decision-ledger"). */
export async function decisionLogId(name: string): Promise<Hex> {
  if (!name || name.length > 256) fail("invalid_log_name");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`attest.decision-log/v1\n${name}`));
  return `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export function anchorEpochArgs(log: Hex, epoch: SealedEpoch) {
  if (epoch.size !== epoch.lastSeq - epoch.firstSeq + 1) fail("invalid_epoch", "size");
  return [log, seq(epoch.epoch, "epoch"), toBytes32(epoch.root, "root"), seq(epoch.firstSeq, "firstSeq"),
    seq(epoch.lastSeq, "lastSeq"), toBytes32(epoch.firstPrevHash, "firstPrevHash"), toBytes32(epoch.lastLeafHash, "lastLeafHash")] as const;
}

/** Read an anchored epoch at a settled block. Returns null if it is not (yet) anchored there. */
export async function readAnchoredEpoch(
  reader: ChainStatusReader,
  query: { address: Address; log: Hex; epoch: number },
  snapshot?: ChainSnapshot,
): Promise<AnchoredEpoch | null> {
  const at = snapshot ?? (await reader.snapshot());
  const raw = (await reader.read(at, (client, blockNumber) =>
    client.readContract({ address: query.address, abi: decisionLogAnchorAbi, functionName: "getEpoch",
      args: [query.log, seq(query.epoch, "epoch")], blockNumber }))) as {
    root: Hex; firstSeq: bigint; lastSeq: bigint; firstPrevHash: Hex; lastLeafHash: Hex; anchoredAt: bigint;
  };
  if (/^0x0{64}$/i.test(raw.root)) return null;
  const firstSeq = Number(raw.firstSeq), lastSeq = Number(raw.lastSeq);
  return {
    epoch: query.epoch, root: fromBytes32(raw.root), firstSeq, lastSeq, size: lastSeq - firstSeq + 1,
    firstPrevHash: fromBytes32(raw.firstPrevHash), lastLeafHash: fromBytes32(raw.lastLeafHash),
    anchoredAt: Number(raw.anchoredAt) * 1000, evidence: chainEvidence(at),
  };
}

/** Minimal clients the publisher needs (viem PublicClient / WalletClient satisfy these). */
export interface AnchorPublisherClients {
  /** The chain the write will actually go to, asked of the RPC/wallet. The write gate trusts only this. */
  getChainId(): Promise<number>;
  /** Optional declared chain: refused early by the write gate, and must match getChainId() at anchor time. */
  chainId?: number;
  readLatest(args: { address: Address; functionName: "latestEpoch" | "getEpoch"; args: readonly unknown[] }): Promise<unknown>;
  simulateAndWrite(args: { address: Address; functionName: "anchorEpoch"; args: readonly unknown[] }): Promise<Hex>;
  waitForReceipt(hash: Hex, confirmations: number): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}
export interface AnchorReceipt { adapter: string; ref: string; anchoredAt: number }

/**
 * A RootAnchor adapter for Gatekeeper's ledger (`packages/ledger/anchor.ts`). Idempotent: an epoch
 * already anchored with the same commitment returns a receipt; a different commitment for the same
 * epoch fails with anchor_conflict instead of being overwritten. Mainnet and unknown chains are
 * refused by assertWritable until the production release gate is lifted (specs/production-readiness.md).
 */
export function decisionLogAnchorAdapter(options: {
  clients: AnchorPublisherClients;
  address: Address;
  log: Hex;
  confirmations?: number;
  now?: () => number;
}) {
  const { clients, address, log } = options;
  const confirmations = options.confirmations ?? 2;
  const now = options.now ?? (() => Date.now());
  // Fail fast on a declared chain; the authoritative check is against the RPC in anchor().
  if (clients.chainId !== undefined) assertWritable(clients.chainId);
  return {
    adapter: "attest-evm",
    async anchor(epoch: SealedEpoch): Promise<AnchorReceipt> {
      const args = anchorEpochArgs(log, epoch);
      // Mainnet and unknown chains are refused by the shared write gate (specs/networks.md), using the
      // chain the client is really connected to, before any read or write.
      const chainId = await clients.getChainId();
      if (clients.chainId !== undefined && clients.chainId !== chainId)
        fail("chain_mismatch", `declared ${clients.chainId}, RPC reports ${chainId}`);
      assertWritable(chainId);
      const ref = (suffix: string) => `eip155:${chainId}:${address.toLowerCase()}:${log}:${suffix}`;
      const latest = Number(await clients.readLatest({ address, functionName: "latestEpoch", args: [log] }));
      if (latest >= epoch.epoch) {
        const existing = (await clients.readLatest({ address, functionName: "getEpoch", args: [log, BigInt(epoch.epoch)] })) as {
          root: Hex; firstSeq: bigint; lastSeq: bigint; firstPrevHash: Hex; lastLeafHash: Hex; anchoredAt: bigint;
        };
        const same = fromBytes32(existing.root) === epoch.root && Number(existing.firstSeq) === epoch.firstSeq &&
          Number(existing.lastSeq) === epoch.lastSeq && fromBytes32(existing.lastLeafHash) === epoch.lastLeafHash &&
          fromBytes32(existing.firstPrevHash) === epoch.firstPrevHash;
        if (!same) fail("anchor_conflict", `epoch ${epoch.epoch}`);
        return { adapter: "attest-evm", ref: ref(`epoch:${epoch.epoch}`), anchoredAt: Number(existing.anchoredAt) * 1000 };
      }
      if (latest + 1 !== epoch.epoch) fail("anchor_out_of_order", `chain at ${latest}, epoch ${epoch.epoch}`);
      const hash = await clients.simulateAndWrite({ address, functionName: "anchorEpoch", args });
      const receipt = await clients.waitForReceipt(hash, confirmations);
      if (receipt.status !== "success") fail("anchor_reverted", hash);
      return { adapter: "attest-evm", ref: ref(`tx:${hash}@${receipt.blockNumber}`), anchoredAt: now() };
    },
  };
}

// RFC 6962 / RFC 9162 Merkle hashing over hex leaf data (Gatekeeper leaf hashes), WebCrypto only.
const bytes = (h: string): Uint8Array<ArrayBuffer> => {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) fail("invalid_hex");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
async function digest(...parts: Uint8Array[]): Promise<string> {
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)), (b) => b.toString(16).padStart(2, "0")).join("");
}
const leafNode = (leaf: string) => digest(Uint8Array.of(0), bytes(leaf));
const innerNode = (l: string, r: string) => digest(Uint8Array.of(1), bytes(l), bytes(r));
const split = (n: number) => { let k = 1; while (k * 2 < n) k *= 2; return k; };
async function treeHash(nodes: readonly string[]): Promise<string> {
  if (nodes.length === 1) return nodes[0]!;
  const k = split(nodes.length);
  return innerNode(await treeHash(nodes.slice(0, k)), await treeHash(nodes.slice(k)));
}
export async function merkleRoot(leaves: readonly string[]): Promise<string> {
  return leaves.length ? treeHash(await Promise.all(leaves.map(leafNode))) : digest();
}
export async function inclusionProof(leaves: readonly string[], index: number): Promise<string[]> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length) fail("index_out_of_range");
  const walk = async (m: number, d: readonly string[]): Promise<string[]> => {
    if (d.length === 1) return [];
    const k = split(d.length);
    return m < k ? [...(await walk(m, d.slice(0, k))), await treeHash(d.slice(k))]
      : [...(await walk(m - k, d.slice(k))), await treeHash(d.slice(0, k))];
  };
  return walk(index, await Promise.all(leaves.map(leafNode)));
}
/**
 * Root and every leaf's inclusion path in one pass: n - 1 inner hashes instead of an
 * inclusionProof call per leaf. paths[i] equals inclusionProof(leaves, i).
 */
export async function merkleAuditPaths(leaves: readonly string[]): Promise<{ root: string; paths: string[][] }> {
  if (!leaves.length) return { root: await digest(), paths: [] };
  const build = async (nodes: readonly string[]): Promise<{ root: string; paths: string[][] }> => {
    if (nodes.length === 1) return { root: nodes[0]!, paths: [[]] };
    const k = split(nodes.length);
    const [left, right] = [await build(nodes.slice(0, k)), await build(nodes.slice(k))];
    return {
      root: await innerNode(left.root, right.root),
      paths: [...left.paths.map((p) => [...p, right.root]), ...right.paths.map((p) => [...p, left.root])],
    };
  };
  return build(await Promise.all(leaves.map(leafNode)));
}
/** RFC 9162 §2.1.3.2. Use `size` and `root` from the anchored epoch, never from the proof bundle. */
export async function verifyInclusion(leaf: string, index: number, size: number, path: readonly string[], root: string): Promise<boolean> {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size || path.length > 64) return false;
  if (![...path, root].every((h) => hex64.test(h)) || !/^(?:[0-9a-f]{2})*$/.test(leaf)) return false;
  let fn = index, sn = size - 1, r = await leafNode(leaf);
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await innerNode(p, r);
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else r = await innerNode(r, p);
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && r === root;
}
/** Check a leaf against an epoch read from chain: index is derived from the anchored span. */
export function verifyAnchoredInclusion(anchored: AnchoredEpoch, leaf: { seq: number; leafHash: string; path: readonly string[] }) {
  if (leaf.seq < anchored.firstSeq || leaf.seq > anchored.lastSeq) return Promise.resolve(false);
  return verifyInclusion(leaf.leafHash, leaf.seq - anchored.firstSeq, anchored.size, leaf.path, anchored.root);
}

/**
 * Adapt viem clients for the publisher (keeps viem generics out of callers). The chain is read
 * from `publicClient.getChainId()` at anchor time; `chainId`, if given, is only a cross-check.
 */
export function viemAnchorClients(publicClient: {
  getChainId(): Promise<number>;
  readContract(args: never): Promise<unknown>;
  simulateContract(args: never): Promise<{ request: unknown }>;
  waitForTransactionReceipt(args: never): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}, walletClient: { writeContract(args: never): Promise<Hex>; getChainId?(): Promise<number> }, account: Address, chainId?: number): AnchorPublisherClients {
  return {
    // Both transports must report the same chain: the gate checks the chain the transaction is sent on.
    getChainId: async () => {
      const [read, write] = await Promise.all([publicClient.getChainId(), walletClient.getChainId?.()]);
      if (write !== undefined && write !== read) fail("chain_mismatch", `reader ${read}, wallet ${write}`);
      return read;
    },
    ...(chainId === undefined ? {} : { chainId }),
    readLatest: (a) => publicClient.readContract({ ...a, abi: decisionLogAnchorAbi } as never),
    simulateAndWrite: async (a) => {
      const sim = await publicClient.simulateContract({ ...a, abi: decisionLogAnchorAbi, account } as never);
      return walletClient.writeContract(sim.request as never);
    },
    waitForReceipt: (hash, confirmations) => publicClient.waitForTransactionReceipt({ hash, confirmations } as never),
  };
}
