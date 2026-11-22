/**
 * ChainStatusReader: consistent, fail-closed status reads for verifiers.
 *
 * - Every endpoint must report the expected chain ID and the same block hash at
 *   the chosen height (finalized, or N confirmations).
 * - Every contract read runs on every endpoint at that height; any difference
 *   fails closed rather than trusting one RPC.
 * - After the reads, the block hash is re-checked, so a reorg during the read
 *   window is detected instead of silently mixing states.
 * - Stale endpoints (head block older than the configured bound) are refused.
 *
 * Results carry chain evidence (chain ID, block number and hash, observation
 * time) in the shape @attest/verifier's status port expects.
 */
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, parseAbi, type Address, type Hex,
} from "viem";
import { registryAbi } from "./connected";

export type Finality =
  | { kind: "finalized" }
  | { kind: "confirmations"; confirmations: number };

/** The subset of a viem PublicClient the reader needs. */
export interface ChainReadClient {
  getChainId(): Promise<number>;
  getBlock(args: { blockTag: "finalized" | "latest" } | { blockNumber: bigint }): Promise<{
    number: bigint | null;
    hash: Hex | null;
    timestamp: bigint;
  }>;
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    blockNumber: bigint;
  }): Promise<unknown>;
}
export interface ChainEndpoint {
  /** Operator label for errors and logs, never a URL with credentials. */
  name: string;
  client: ChainReadClient;
}
export interface ChainStatusReaderOptions {
  chainId: number;
  endpoints: readonly ChainEndpoint[];
  /** Independent endpoints required (default 2). Use 1 only for local development. */
  minEndpoints?: number;
  finality: Finality;
  /** Refuse snapshots whose block is older than this (ms). Detects stuck RPCs. */
  maxBlockAgeMs: number;
  now(): number;
}
export interface ChainSnapshot {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  /** Block timestamp, seconds. */
  timestamp: bigint;
  /** When the snapshot was taken, ms. */
  observedAt: number;
}
export class ChainStatusError extends Error {
  readonly _tag = "ChainStatusError";
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ChainStatusError";
    this.code = code;
  }
}
const fail = (code: string, detail?: string): never => {
  throw new ChainStatusError(code, detail);
};

/** Stable comparison of viem results (bigint, arrays, tuples, objects, case-insensitive hex). */
export function canonicalChainValue(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (typeof v === "bigint") return `bigint:${v.toString()}`;
    if (typeof v === "string") return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, visit((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(visit(value));
}

export interface ChainStatusReader {
  readonly options: Readonly<ChainStatusReaderOptions>;
  snapshot(): Promise<ChainSnapshot>;
  /** Run `read` on every endpoint at the snapshot height, require identical results, then re-check the block hash. */
  read<T>(snapshot: ChainSnapshot, read: (client: ChainReadClient, blockNumber: bigint) => Promise<T>): Promise<T>;
}

export function createChainStatusReader(options: ChainStatusReaderOptions): ChainStatusReader {
  const minEndpoints = options.minEndpoints ?? 2;
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) fail("invalid_reader_configuration", "chainId");
  if (!Number.isSafeInteger(minEndpoints) || minEndpoints < 1) fail("invalid_reader_configuration", "minEndpoints");
  if (options.endpoints.length < minEndpoints) fail("insufficient_endpoints");
  if (new Set(options.endpoints.map((e) => e.name)).size !== options.endpoints.length)
    fail("invalid_reader_configuration", "duplicate endpoint names");
  if (options.finality.kind === "confirmations") {
    const n = options.finality.confirmations;
    if (!Number.isSafeInteger(n) || n < 1 || n > 256) fail("invalid_reader_configuration", "confirmations");
  }
  if (!Number.isSafeInteger(options.maxBlockAgeMs) || options.maxBlockAgeMs <= 0)
    fail("invalid_reader_configuration", "maxBlockAgeMs");

  const all = <T>(run: (e: ChainEndpoint) => Promise<T>) =>
    Promise.all(
      options.endpoints.map(async (e) => {
        try {
          return await run(e);
        } catch (cause) {
          if (cause instanceof ChainStatusError) throw cause;
          // Error class only: provider messages can embed RPC URLs that carry credentials.
          return fail("endpoint_unavailable", `${e.name} (${cause instanceof Error ? cause.name : typeof cause})`);
        }
      }),
    );
  const blockAt = async (e: ChainEndpoint, blockNumber: bigint) => {
    const b = await e.client.getBlock({ blockNumber });
    if (b.number !== blockNumber || !b.hash) fail("endpoint_unavailable", e.name);
    return { hash: b.hash!.toLowerCase() as Hex, timestamp: b.timestamp };
  };
  const sameHash = async (blockNumber: bigint, expected?: Hex) => {
    const blocks = await all((e) => blockAt(e, blockNumber));
    const hash = blocks[0]!.hash;
    if (blocks.some((b) => b.hash !== hash || b.timestamp !== blocks[0]!.timestamp)) fail("rpc_disagreement", "block hash");
    if (expected && hash !== expected) fail("reorg_detected");
    return blocks[0]!;
  };

  return {
    options,
    async snapshot() {
      const now = options.now();
      const ids = await all((e) => e.client.getChainId());
      if (ids.some((id) => id !== options.chainId)) fail("chain_mismatch");
      const heights = await all(async (e) => {
        const tag = options.finality.kind === "finalized" ? "finalized" : "latest";
        const head = await e.client.getBlock({ blockTag: tag });
        if (head.number === null) return fail("endpoint_unavailable", e.name);
        if (now - Number(head.timestamp) * 1000 > options.maxBlockAgeMs) fail("chain_stale", e.name);
        return options.finality.kind === "finalized"
          ? head.number
          : head.number - BigInt(options.finality.confirmations - 1);
      });
      // The lowest height every endpoint considers settled.
      const blockNumber = heights.reduce((a, b) => (b < a ? b : a));
      if (blockNumber < 0n) fail("chain_too_short");
      const block = await sameHash(blockNumber);
      return { chainId: options.chainId, blockNumber, blockHash: block.hash, timestamp: block.timestamp, observedAt: now };
    },
    async read(snapshot, read) {
      if (snapshot.chainId !== options.chainId) fail("chain_mismatch");
      const results = await all((e) => read(e.client, snapshot.blockNumber));
      const first = canonicalChainValue(results[0]);
      if (results.some((r) => canonicalChainValue(r) !== first)) fail("rpc_disagreement", "read result");
      await sameHash(snapshot.blockNumber, snapshot.blockHash);
      return results[0]!;
    },
  };
}

/** Chain evidence in @attest/verifier's StatusEvidence shape. */
export function chainEvidence(snapshot: ChainSnapshot) {
  if (snapshot.blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) fail("block_number_unsafe");
  return {
    source: "chain" as const,
    observedAt: snapshot.observedAt,
    chainId: snapshot.chainId,
    blockNumber: Number(snapshot.blockNumber),
    blockHash: snapshot.blockHash.toLowerCase() as Hex,
  };
}

export interface WorkspaceAnchorQuery {
  registry: Address;
  /** Anchor key, as written by the issuer (for example commitValue(credential id)). */
  anchorId: Hex;
  /** Expected issuer account, scope and content commitment; any mismatch fails closed. */
  issuer: Address;
  scope: Hex;
  commitment: Hex;
  /** Expected commitment to the issuer's credential-signing public key. */
  signingKeyHash: Hex;
}
export type AnchorStatus = {
  status: "active" | "revoked" | "superseded" | "expired";
  /** Why the credential is not active, when it is not. */
  reason?: "anchor_revoked" | "anchor_expired" | "issuer_grant_inactive" | "issuer_key_changed";
  /** Anchor validity end, ms. */
  validUntil: number;
  evidence: ReturnType<typeof chainEvidence>;
};

const registryVersionAbi = parseAbi(["function registryVersion() pure returns (uint256)"]);
/**
 * Interface version of a WorkspaceRegistry at a block. V1 has no registryVersion(): a contract
 * revert or empty return means 1. Transport errors are rethrown, never read as V1.
 */
export async function readRegistryVersion(client: ChainReadClient, address: Address, blockNumber: bigint): Promise<bigint> {
  try {
    return (await client.readContract({ address, abi: registryVersionAbi, functionName: "registryVersion", blockNumber })) as bigint;
  } catch (cause) {
    const reverted = cause instanceof BaseError &&
      cause.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
    if (reverted) return 1n;
    throw cause;
  }
}

/**
 * Status of a WorkspaceRegistry (V1) anchor plus its issuer grant, read consistently at one
 * settled block. Returns null when no anchor exists. Directly usable as the return value
 * of @attest/verifier's `status` port.
 *
 * V1 semantics only: a registry reporting registryVersion() >= 2 is refused with
 * `registry_requires_v2_reader`, because this reader ignores V2 key windows, compromise
 * cutoffs and per-issuer anchor ids. Use registryV2AnchorStatus for V2.
 */
export async function workspaceAnchorStatus(
  reader: ChainStatusReader,
  query: WorkspaceAnchorQuery,
  snapshot?: ChainSnapshot,
): Promise<AnchorStatus | null> {
  const at = snapshot ?? (await reader.snapshot());
  const [version, anchor, grant] = await reader.read(at, (client, blockNumber) =>
    Promise.all([
      readRegistryVersion(client, query.registry, blockNumber),
      client.readContract({ address: query.registry, abi: registryAbi, functionName: "anchors", args: [query.anchorId], blockNumber }),
      client.readContract({ address: query.registry, abi: registryAbi, functionName: "issuers", args: [query.issuer, query.scope], blockNumber }),
    ]),
  ) as [bigint, [Address, Hex, Hex, bigint, boolean], [boolean, Hex]];
  if (version >= 2n) fail("registry_requires_v2_reader", `registryVersion ${version}`);
  const [issuer, scope, commitment, validUntil, revoked] = anchor;
  if (/^0x0{40}$/i.test(issuer)) return null;
  if (issuer.toLowerCase() !== query.issuer.toLowerCase() || scope.toLowerCase() !== query.scope.toLowerCase() ||
    commitment.toLowerCase() !== query.commitment.toLowerCase())
    fail("anchor_mismatch");
  const evidence = chainEvidence(at);
  const validUntilMs = Number(validUntil) * 1000;
  const inactive = (reason: AnchorStatus["reason"], status: AnchorStatus["status"] = "revoked"): AnchorStatus =>
    ({ status, reason: reason!, validUntil: validUntilMs, evidence });
  if (revoked) return inactive("anchor_revoked");
  if (validUntil <= at.timestamp) return inactive("anchor_expired", "expired");
  if (!grant[0]) return inactive("issuer_grant_inactive");
  if (grant[1].toLowerCase() !== query.signingKeyHash.toLowerCase()) return inactive("issuer_key_changed");
  return { status: "active", validUntil: validUntilMs, evidence };
}

/** Adapt a viem PublicClient (any transport) into a reader endpoint. */
export function publicClientEndpoint(
  name: string,
  client: {
    getChainId(): Promise<number>;
    getBlock(args: never): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
    readContract(args: never): Promise<unknown>;
  },
): ChainEndpoint {
  return {
    name,
    client: {
      getChainId: () => client.getChainId(),
      getBlock: (args) => client.getBlock(args as never),
      readContract: (args) => client.readContract(args as never),
    },
  };
}
