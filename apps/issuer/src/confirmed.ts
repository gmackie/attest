/**
 * Confirmed reads for the hosted demo verifiers (ATTE-27).
 *
 * Decisions are checked at a block with DECISION_CONFIRMATIONS confirmations, read
 * consistently from every configured RPC (ChainStatusReader: matching chain ID, block hash
 * and values; reorgs during the read fail closed). If the confirmed state differs from the
 * latest state, for example a credential written seconds ago or a revocation not yet
 * confirmed, the request is answered "awaiting confirmations" so the client can retry,
 * instead of being judged on unconfirmed or stale data.
 *
 * The demo deliberately uses confirmations rather than finality (about 13 minutes on Sepolia)
 * so holders can verify shortly after issuance. Pilot verifiers should use finality.
 */
import {
  canonicalChainValue, ChainStatusError, createChainStatusReader,
  type ChainEndpoint, type ChainReadClient, type ChainSnapshot, type ChainStatusReader,
} from "@attest/chain-evm";

export const DECISION_CONFIRMATIONS = 3;
/** Sepolia produces a block about every 12 s. */
const SECONDS_PER_BLOCK = 12;

export class AwaitingConfirmations extends Error {
  readonly code = "awaiting_confirmations";
  constructor(readonly retryAfterSeconds: number, readonly confirmations: number) {
    super(`Waiting for ${confirmations} block confirmations before verifying`);
  }
}

export function decisionReader(endpoints: readonly ChainEndpoint[], now: () => number = () => Date.now()): ChainStatusReader {
  return createChainStatusReader({
    chainId: 11155111,
    endpoints,
    // Every configured endpoint must agree; production config supplies two.
    minEndpoints: endpoints.length,
    finality: { kind: "confirmations", confirmations: DECISION_CONFIRMATIONS },
    maxBlockAgeMs: 300_000,
    now,
  });
}

/**
 * Read at the confirmed block. If the same read at `latest` (primary endpoint) differs,
 * throw AwaitingConfirmations. ChainStatusError propagates for the caller to map to 503.
 */
export async function confirmedRead<T>(
  reader: ChainStatusReader,
  latest: ChainReadClient,
  read: (client: ChainReadClient, blockNumber: bigint) => Promise<T>,
  attempts = 2,
): Promise<{ value: T; snapshot: ChainSnapshot }> {
  try {
    return await confirmedReadOnce(reader, latest, read);
  } catch (e) {
    // One retry for a transient provider failure; disagreement, reorgs and staleness are never retried.
    if (attempts > 1 && e instanceof ChainStatusError && e.code === "endpoint_unavailable")
      return confirmedRead(reader, latest, read, attempts - 1);
    throw e;
  }
}
async function confirmedReadOnce<T>(
  reader: ChainStatusReader,
  latest: ChainReadClient,
  read: (client: ChainReadClient, blockNumber: bigint) => Promise<T>,
): Promise<{ value: T; snapshot: ChainSnapshot }> {
  const snapshot = await reader.snapshot();
  const value = await reader.read(snapshot, read);
  const head = await latest.getBlock({ blockTag: "latest" });
  if (head.number === null) throw new ChainStatusError("endpoint_unavailable", "latest");
  if (head.number > snapshot.blockNumber) {
    const current = await read(latest, head.number);
    if (canonicalChainValue(current) !== canonicalChainValue(value)) {
      const remaining = Number(snapshot.blockNumber + BigInt(DECISION_CONFIRMATIONS) - head.number) + DECISION_CONFIRMATIONS;
      throw new AwaitingConfirmations(Math.max(SECONDS_PER_BLOCK, Math.min(60, remaining * SECONDS_PER_BLOCK)), DECISION_CONFIRMATIONS);
    }
  }
  return { value, snapshot };
}
