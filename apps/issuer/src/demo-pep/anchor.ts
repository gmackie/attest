/**
 * Publishing the demo PEP's sealed epochs to DecisionLogAnchor (ATTE-20 follow-up).
 *
 * Runs from the DemoPepService alarm, never inside the request queue: the queue is entered only
 * for short reads and writes of local state, and every chain call (simulate, send, wait for the
 * receipt) happens between them. At most one publication is in flight per object.
 *
 * Fails closed and degrades honestly: with no or invalid configuration nothing is sent and the
 * PEP keeps working ("sealed locally"); a failed attempt records only a sanitized error code on
 * the epoch and backs off exponentially. The adapter is idempotent (an already anchored epoch
 * with the same commitment returns a receipt; a different one is `anchor_conflict`), and refuses
 * mainnet and unlisted chains, using the chain the RPC reports.
 */
import {
  createPublicClient, createWalletClient, fallback, http, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertWritable, decisionLogAnchorAbi, decisionLogAnchorAdapter, decisionLogId, networkByChainId, viemAnchorClients,
  type AnchorPublisherClients,
} from "@attest/chain-evm";
import { DEMO_LEDGER_NAME } from "./config";
import { readEpoch, type EpochRow, type Store } from "./ledger";

export interface AnchorConfig { chainId: number; address: Address; logId: Hex }
export interface AnchorEnv {
  /** JSON `{"chainId", "address", "logId"}`: where this PEP's epochs are anchored. */
  DEMO_PEP_ANCHOR?: string;
  /** Secret: the publisher's EVM private key, 0x + 64 hex. Never logged or returned. */
  DEMO_PEP_ANCHOR_KEY?: string;
}
export type AnchorSetup =
  | { status: "not-configured" }
  | { status: "misconfigured"; code: string }
  | { status: "ready"; config: AnchorConfig; key: Hex };

/** On-chain record of an anchored epoch, stored on the epoch row and served with receipts. */
export interface EpochAnchor {
  chainId: number;
  address: Address;
  logId: Hex;
  /** Null when the epoch was found already anchored (idempotent retry) and its transaction was not located. */
  txHash: Hex | null;
  blockNumber: number | null;
  anchoredAt: number;
  ref: string;
}
export interface AnchorState {
  next: number;
  failures: number;
  nextAttemptAt: number;
  lastError: { code: string; epoch: number; at: number } | null;
}

/** Fee cap: Sepolia's base fee is ~17 wei; 1000 wei per gas leaves headroom without overpaying. */
export const MAX_FEE_PER_GAS = 1000n;
export const MAX_PRIORITY_FEE_PER_GAS = 10n;
export const MAX_EPOCHS_PER_RUN = 3;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 3_600_000;

class AnchorConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Strict: exactly 0x + 64 hex digits and a valid secp256k1 scalar. The value never appears in an error. */
export function parseAnchorKey(raw: unknown): Hex {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new AnchorConfigError("anchor_key_invalid");
  try {
    privateKeyToAccount(raw as Hex);
  } catch {
    throw new AnchorConfigError("anchor_key_invalid");
  }
  return raw.toLowerCase() as Hex;
}

export function parseAnchorConfig(raw: unknown): AnchorConfig {
  let v: unknown;
  try {
    v = JSON.parse(String(raw));
  } catch {
    throw new AnchorConfigError("anchor_config_invalid");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new AnchorConfigError("anchor_config_invalid");
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "address,chainId,logId" || !Number.isSafeInteger(o.chainId) ||
    typeof o.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.address) ||
    typeof o.logId !== "string" || !/^0x[0-9a-f]{64}$/.test(o.logId))
    throw new AnchorConfigError("anchor_config_invalid");
  return { chainId: o.chainId as number, address: o.address as Address, logId: o.logId as Hex };
}

/** Whether anchoring can run. Never throws: a bad setting disables anchoring, not the PEP. */
export async function anchorSetup(env: AnchorEnv): Promise<AnchorSetup> {
  if (!env.DEMO_PEP_ANCHOR) return { status: "not-configured" };
  try {
    const config = parseAnchorConfig(env.DEMO_PEP_ANCHOR);
    if (!networkByChainId(config.chainId)) throw new AnchorConfigError("anchor_chain_unknown");
    try {
      assertWritable(config.chainId);
    } catch {
      throw new AnchorConfigError("anchor_chain_not_writable");
    }
    if (config.logId !== (await decisionLogId(DEMO_LEDGER_NAME))) throw new AnchorConfigError("anchor_log_mismatch");
    if (!env.DEMO_PEP_ANCHOR_KEY) throw new AnchorConfigError("anchor_key_missing");
    return { status: "ready", config, key: parseAnchorKey(env.DEMO_PEP_ANCHOR_KEY) };
  } catch (e) {
    return { status: "misconfigured", code: e instanceof AnchorConfigError ? e.code : "anchor_config_invalid" };
  }
}

/**
 * Publisher clients for a network: reads and simulation through both of the network's RPCs (viem
 * fallback), the wallet over the same, and every write capped at MAX_FEE_PER_GAS.
 */
export function publisherClients(config: AnchorConfig, key: Hex, options: {
  rpcUrls?: readonly string[]; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint;
} = {}): AnchorPublisherClients {
  const network = networkByChainId(config.chainId);
  if (!network) throw new AnchorConfigError("anchor_chain_unknown");
  const urls = options.rpcUrls ?? network.rpcUrls.map((r) => r.url);
  const transport = fallback(urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })));
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: network.chain, transport });
  const wallet = createWalletClient({ chain: network.chain, transport, account });
  const maxFeePerGas = options.maxFeePerGas ?? MAX_FEE_PER_GAS;
  const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? MAX_PRIORITY_FEE_PER_GAS;
  const capped = {
    getChainId: () => wallet.getChainId(),
    writeContract: (args: never) =>
      wallet.writeContract({ ...(args as object), account, maxFeePerGas, maxPriorityFeePerGas } as never),
  };
  return viemAnchorClients(publicClient as never, capped as never, account, config.chainId);
}

/** A stable, value-free error code: never a message that could carry request data or key material. */
export function anchorErrorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) return code;
  const text = `${(e as { shortMessage?: string })?.shortMessage ?? ""}\n${(e as Error)?.message ?? ""}`;
  const reason = /reverted with the following reason:\s*\n?\s*([A-Za-z0-9 _-]{1,64})/.exec(text)?.[1];
  if (reason) return `contract_reverted:${reason.trim().replace(/\s+/g, "_").toLowerCase()}`;
  const name = (e as { name?: unknown })?.name;
  return typeof name === "string" && /^[A-Za-z]{1,64}$/.test(name) ? `rpc_error:${name}` : "anchor_failed";
}
export const backoffMs = (failures: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));

const parseRef = (ref: string) => {
  const m = /:tx:(0x[0-9a-f]{64})@(\d+)$/.exec(ref);
  return m ? { txHash: m[1] as Hex, blockNumber: Number(m[2]) } : { txHash: null, blockNumber: null };
};

export interface AnchorDeps {
  now?: () => number;
  /** Override the clients (tests: a local anvil; negative tests: a wrong chain). */
  clients?: (config: AnchorConfig, key: Hex) => AnchorPublisherClients;
  confirmations?: number;
}
export type AnchorReport =
  | { status: "not-configured" }
  | { status: "misconfigured"; code: string }
  | { status: "idle" | "backing-off"; anchored: number[] }
  | { status: "anchored"; anchored: number[]; more: boolean }
  | { status: "failed"; anchored: number[]; code: string; epoch: number; retryAt: number };

/**
 * `run` executes a task inside the object's request queue. It is used only for local reads and
 * writes; the chain calls happen outside it.
 */
export function createAnchorPublisher(deps: AnchorDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const clientsFor = deps.clients ?? ((config: AnchorConfig, key: Hex) => publisherClients(config, key));
  let inflight: Promise<AnchorReport> | null = null;

  const state = async (store: Store): Promise<AnchorState> =>
    (await store.get<AnchorState>("anchor:state")) ?? { next: 1, failures: 0, nextAttemptAt: 0, lastError: null };

  async function publishOnce(store: Store, env: AnchorEnv, run: <T>(task: () => Promise<T>) => Promise<T>): Promise<AnchorReport> {
    const setup = await anchorSetup(env);
    if (setup.status !== "ready") return setup;
    const { config, key } = setup;
    const anchored: number[] = [];
    for (let i = 0; i < MAX_EPOCHS_PER_RUN; i++) {
      const job = await run(async () => {
        const s = await state(store);
        if (now() < s.nextAttemptAt) return { wait: true as const };
        const epoch = await readEpoch(store, s.next);
        return { wait: false as const, epoch: epoch ?? null };
      });
      if (job.wait) return { status: "backing-off", anchored };
      if (!job.epoch) return { status: anchored.length ? "anchored" : "idle", anchored, more: false } as AnchorReport;
      const epoch: EpochRow = job.epoch;
      try {
        const clients = clientsFor(config, key);
        const adapter = decisionLogAnchorAdapter({
          clients, address: config.address, log: config.logId, confirmations: deps.confirmations ?? 2, now,
        });
        const receipt = await adapter.anchor(epoch);
        let { txHash, blockNumber } = parseRef(receipt.ref);
        if (!txHash) ({ txHash, blockNumber } = await findAnchorTx(clients, config, epoch.epoch).catch(() => ({ txHash: null, blockNumber: null })));
        const record: EpochAnchor = {
          chainId: config.chainId, address: config.address, logId: config.logId, txHash, blockNumber,
          anchoredAt: receipt.anchoredAt, ref: receipt.ref,
        };
        await run(async () => {
          const row = await readEpoch(store, epoch.epoch);
          // An idempotent retry does not learn the transaction again; keep one recorded earlier.
          const earlier = row?.anchor as EpochAnchor | undefined;
          if (!record.txHash && earlier?.txHash) Object.assign(record, { txHash: earlier.txHash, blockNumber: earlier.blockNumber });
          if (row) await store.put(`ledger:epoch:${epoch.epoch}`, { ...row, anchor: record, anchorError: null });
          await store.put("anchor:state", { next: epoch.epoch + 1, failures: 0, nextAttemptAt: 0, lastError: null } satisfies AnchorState);
        });
        anchored.push(epoch.epoch);
      } catch (e) {
        const code = anchorErrorCode(e), at = now();
        const retryAt = await run(async () => {
          const s = await state(store);
          const failures = s.failures + 1, retry = at + backoffMs(failures);
          const row = await readEpoch(store, epoch.epoch);
          if (row) await store.put(`ledger:epoch:${epoch.epoch}`, { ...row, anchorError: { code, at } });
          await store.put("anchor:state", { ...s, failures, nextAttemptAt: retry, lastError: { code, epoch: epoch.epoch, at } } satisfies AnchorState);
          return retry;
        });
        return { status: "failed", anchored, code, epoch: epoch.epoch, retryAt };
      }
    }
    return { status: "anchored", anchored, more: true };
  }

  return {
    /** At most one publication in flight; a concurrent call joins the running one. */
    publish(store: Store, env: AnchorEnv, run: <T>(task: () => Promise<T>) => Promise<T>): Promise<AnchorReport> {
      inflight ??= publishOnce(store, env, run).finally(() => { inflight = null; });
      return inflight;
    },
    state,
  };
}

/** Best effort, for idempotent retries: the EpochAnchored event of this log and epoch. */
async function findAnchorTx(clients: AnchorPublisherClients, config: AnchorConfig, epoch: number) {
  const c = clients as AnchorPublisherClients & { getLogs?: (a: unknown) => Promise<{ transactionHash: Hex; blockNumber: bigint }[]> };
  if (!c.getLogs) return { txHash: null, blockNumber: null };
  const logs = await c.getLogs({ address: config.address, abi: decisionLogAnchorAbi, eventName: "EpochAnchored",
    args: { log: config.logId, epoch: BigInt(epoch) } });
  const hit = logs[0];
  return hit ? { txHash: hit.transactionHash, blockNumber: Number(hit.blockNumber) } : { txHash: null, blockNumber: null };
}
