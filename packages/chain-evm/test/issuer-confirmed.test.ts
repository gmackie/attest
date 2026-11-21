import { describe, expect, it } from "vitest";
import type { ChainEndpoint, ChainReadClient } from "../src/status";
import { AwaitingConfirmations, confirmedRead, DECISION_CONFIRMATIONS, decisionReader } from "../../../apps/issuer/src/confirmed";

/** A deterministic chain: block n has hash h(n) and the contract value given by `state(n)`. */
function chain(head: bigint, state: (n: bigint) => unknown, over: Partial<ChainReadClient> = {}): ChainReadClient {
  const now = Math.floor(Date.now() / 1000);
  const block = (n: bigint) => ({ number: n, hash: `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`, timestamp: BigInt(now) - (head - n) * 12n });
  return {
    getChainId: async () => 11155111,
    getBlock: async (args) => block("blockNumber" in args ? args.blockNumber : head),
    readContract: async (args) => state(args.blockNumber),
    ...over,
  };
}
const endpoints = (...clients: ChainReadClient[]): ChainEndpoint[] => clients.map((client, i) => ({ name: `rpc${i}`, client }));
const read = (c: ChainReadClient, blockNumber: bigint) =>
  c.readContract({ address: "0x0000000000000000000000000000000000000001", abi: [], functionName: "records", blockNumber });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof AwaitingConfirmations ? "awaiting" : (e as { code?: string }).code ?? String(e); } };

describe("issuer confirmed reads (ATTE-27)", () => {
  const head = 100n, confirmedAt = head - BigInt(DECISION_CONFIRMATIONS - 1);

  it("verifies at the block with the configured confirmations when nothing changed since", async () => {
    const c = chain(head, () => ["0xabc", false]);
    const { value, snapshot } = await confirmedRead(decisionReader(endpoints(c, chain(head, () => ["0xabc", false]))), c, read);
    expect(snapshot.blockNumber).toBe(confirmedAt);
    expect(value).toEqual(["0xabc", false]);
  });

  it("asks the client to retry when a credential was written after the confirmed block", async () => {
    const state = (n: bigint) => (n >= head ? ["0xabc", false] : ["0x0", false]);
    const c = chain(head, state);
    const err = await confirmedRead(decisionReader(endpoints(c, chain(head, state))), c, read).catch((e) => e);
    expect(err).toBeInstanceOf(AwaitingConfirmations);
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(12);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("does not approve against a revocation that is not yet confirmed", async () => {
    const state = (n: bigint) => ["0xabc", n >= head];
    const c = chain(head, state);
    expect(await code(confirmedRead(decisionReader(endpoints(c, chain(head, state))), c, read))).toBe("awaiting");
  });

  it("fails closed when the two RPCs disagree on confirmed state", async () => {
    const a = chain(head, () => ["0xabc", false]), b = chain(head, () => ["0xabc", true]);
    expect(await code(confirmedRead(decisionReader(endpoints(a, b)), a, read))).toBe("rpc_disagreement");
  });

  it("fails closed when an RPC is on another chain or stuck", async () => {
    const a = chain(head, () => 1);
    expect(await code(confirmedRead(decisionReader(endpoints(a, chain(head, () => 1, { getChainId: async () => 1 }))), a, read))).toBe("chain_mismatch");
    const stale = chain(head, () => 1, { getBlock: async () => ({ number: head, hash: `0x${"1".repeat(64)}`, timestamp: 1n }) });
    expect(await code(confirmedRead(decisionReader(endpoints(stale, stale)), stale, read))).toBe("chain_stale");
  });
});

describe("transient provider failures", () => {
  it("retries once on endpoint_unavailable, but never retries disagreement", async () => {
    let calls = 0;
    const good = (n: bigint) => ["0xabc", false];
    const flaky: ChainReadClient = { ...chain(100n, good), getChainId: async () => { if (calls++ === 0) throw new Error("ECONNRESET"); return 11155111; } };
    const a = chain(100n, good);
    expect(await code(confirmedRead(decisionReader(endpoints(a, flaky)), a, read))).toBe("ok");
    const down: ChainReadClient = { ...chain(100n, good), getChainId: async () => { throw new Error("down"); } };
    expect(await code(confirmedRead(decisionReader(endpoints(a, down)), a, read))).toBe("endpoint_unavailable");
    let reads = 0;
    const counting: ChainReadClient = { ...chain(100n, () => ["0xabc", true]), readContract: async () => { reads++; return ["0xabc", true]; } };
    expect(await code(confirmedRead(decisionReader(endpoints(a, counting)), a, read))).toBe("rpc_disagreement");
    expect(reads).toBe(1);
  });
});
