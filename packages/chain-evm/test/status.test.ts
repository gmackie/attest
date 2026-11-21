import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import type { CredentialStatus } from "@attest/verifier";
import { registryAbi } from "../src/connected";
import {
  createChainStatusReader, publicClientEndpoint, workspaceAnchorStatus,
  type ChainEndpoint, type ChainStatusReaderOptions, type WorkspaceAnchorQuery,
} from "../src/status";

const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const available = existsSync(binary);
const root = path.resolve(import.meta.dirname, "../../..");
const portA = 18885, portB = 18886;
const urlA = `http://127.0.0.1:${portA}`, urlB = `http://127.0.0.1:${portB}`;
const client = (url: string) => createPublicClient({ chain: sepolia, transport: http(url) });
const readerA = client(urlA), wallet = createWalletClient({ chain: sepolia, transport: http(urlA) });
const hex = (digit: string) => `0x${digit.repeat(64)}` as Hex;
let anvils: ChildProcess[] = [], accounts: Address[] = [], registry: Address;

async function rpc(url: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const mine = (blocks = 3, url = urlA) => rpc(url, "anvil_mine", [`0x${blocks.toString(16)}`]);
async function write(account: Address, functionName: string, args: readonly unknown[]) {
  const sim = await readerA.simulateContract({ address: registry, abi: registryAbi, account,
    functionName: functionName as never, args: args as never });
  await readerA.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
}
const chainTime = async () => Number((await readerA.getBlock({ blockTag: "latest" })).timestamp) * 1000;
async function options(over: Partial<ChainStatusReaderOptions> = {}): Promise<ChainStatusReaderOptions> {
  const now = await chainTime();
  return {
    chainId: 11155111,
    // Two independent clients of the same chain.
    endpoints: [publicClientEndpoint("primary", client(urlA)), publicClientEndpoint("secondary", client(urlA))],
    finality: { kind: "finalized" }, maxBlockAgeMs: 600_000, now: () => now, ...over,
  };
}
const code = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
};

beforeAll(async () => {
  if (!available) return;
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], { cwd: path.join(root, "contracts"), encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  // One-slot epochs: "finalized" trails "latest" by two blocks.
  for (const port of [portA, portB])
    anvils.push(spawn(binary, ["--port", String(port), "--chain-id", "11155111", "--slots-in-an-epoch", "1", "--silent"], { stdio: "ignore" }));
  for (let i = 0; i < 100 && accounts.length === 0; i++) {
    try { accounts = await wallet.getAddresses(); await client(urlB).getChainId(); }
    catch { accounts = []; await new Promise((r) => setTimeout(r, 100)); }
  }
  if (accounts.length < 3) throw new Error("Anvil failed to start");
  const artifact = JSON.parse(readFileSync(path.join(root, "contracts/artifacts/WorkspaceRegistry.json"), "utf8"));
  const tx = await wallet.deployContract({ account: accounts[0]!, abi: artifact.abi, bytecode: artifact.bytecode });
  registry = (await readerA.waitForTransactionReceipt({ hash: tx })).contractAddress!;
  await mine();
}, 60_000);
afterAll(() => anvils.forEach((a) => a.kill()));

describe.skipIf(!available)("ChainStatusReader", () => {
  it("snapshots the finalized block agreed by every endpoint and attaches chain evidence", async () => {
    const reader = createChainStatusReader(await options());
    const snap = await reader.snapshot();
    const latest = await readerA.getBlock({ blockTag: "latest" });
    expect(snap.blockNumber).toBe(latest.number - 2n);
    expect(snap.blockHash).toBe((await readerA.getBlock({ blockNumber: snap.blockNumber })).hash);
    const confirmed = await createChainStatusReader(await options({ finality: { kind: "confirmations", confirmations: 1 } })).snapshot();
    expect(confirmed.blockNumber).toBe(latest.number);
  });

  it("refuses misconfiguration and single-endpoint trust by default", async () => {
    const base = await options();
    expect(() => createChainStatusReader({ ...base, endpoints: base.endpoints.slice(0, 1) })).toThrow("insufficient_endpoints");
    expect(() => createChainStatusReader({ ...base, finality: { kind: "confirmations", confirmations: 0 } })).toThrow("invalid_reader_configuration");
    expect(() => createChainStatusReader({ ...base, endpoints: [base.endpoints[0]!, base.endpoints[0]!] })).toThrow("invalid_reader_configuration");
  });

  it("fails closed when endpoints follow different chains", async () => {
    await mine(5, urlB);
    const reader = createChainStatusReader(await options({
      endpoints: [publicClientEndpoint("a", client(urlA)), publicClientEndpoint("b", client(urlB))],
      finality: { kind: "confirmations", confirmations: 1 },
    }));
    expect(await code(reader.snapshot())).toBe("rpc_disagreement");
  });

  it("fails closed on a wrong chain ID, an unavailable endpoint or a stale head", async () => {
    const base = await options();
    const lying: ChainEndpoint = { name: "lying", client: { ...base.endpoints[1]!.client, getChainId: async () => 1 } };
    expect(await code(createChainStatusReader({ ...base, endpoints: [base.endpoints[0]!, lying] }).snapshot())).toBe("chain_mismatch");
    const down: ChainEndpoint = { name: "down", client: { ...base.endpoints[1]!.client, getChainId: async () => { throw new Error("ECONNREFUSED"); } } };
    expect(await code(createChainStatusReader({ ...base, endpoints: [base.endpoints[0]!, down] }).snapshot())).toBe("endpoint_unavailable");
    const later = base.now() + 3_600_000;
    expect(await code(createChainStatusReader({ ...base, now: () => later }).snapshot())).toBe("chain_stale");
  });

  it("fails closed when endpoints return different contract state", async () => {
    const base = await options();
    const forged: ChainEndpoint = { name: "forged", client: { ...base.endpoints[1]!.client,
      readContract: async (args) => { const r = await base.endpoints[1]!.client.readContract(args) as unknown[]; return [...r.slice(0, 4), false]; } } };
    const reader = createChainStatusReader({ ...base, endpoints: [base.endpoints[0]!, forged] });
    const snap = await reader.snapshot();
    const read = (c: ChainEndpoint["client"], blockNumber: bigint) =>
      c.readContract({ address: registry, abi: registryAbi, functionName: "anchors", args: [hex("9")], blockNumber });
    // An unanchored id reads identically (revoked=false) on both, so a mismatch needs real state:
    await write(accounts[0]!, "configureIssuer", [accounts[1]!, hex("1"), hex("4"), true]);
    const deadline = BigInt(Math.floor((await chainTime()) / 1000) + 86_400);
    await write(accounts[1]!, "anchor", [hex("8"), hex("1"), hex("3"), deadline]);
    await write(accounts[1]!, "revoke", [hex("8")]);
    await mine();
    const later = await reader.snapshot();
    expect(await code(reader.read(snap, read))).toBe("ok");
    expect(await code(reader.read(later, (c, n) =>
      c.readContract({ address: registry, abi: registryAbi, functionName: "anchors", args: [hex("8")], blockNumber: n })))).toBe("rpc_disagreement");
  });

  it("detects a reorg that replaces the snapshot block during the read window", async () => {
    const reader = createChainStatusReader(await options({ finality: { kind: "confirmations", confirmations: 1 } }));
    const snap = await reader.snapshot();
    // Both endpoint reads wait for one reorg to complete, so they agree on the (replaced) block's state
    // and only the post-read hash check can catch it.
    let reorg: Promise<unknown> | undefined;
    const result = reader.read(snap, async (c, blockNumber) => {
      reorg ??= rpc(urlA, "anvil_reorg", [2, []]);
      await reorg;
      return c.readContract({ address: registry, abi: registryAbi, functionName: "administrator", blockNumber });
    });
    expect(await code(result)).toBe("reorg_detected");
  });

  describe("WorkspaceRegistry anchor status", () => {
    const issuer = () => accounts[1]!;
    const scope = hex("a"), keyHash = hex("b");
    const query = (id: Hex, commitment = hex("c")): WorkspaceAnchorQuery =>
      ({ registry, anchorId: id, issuer: issuer(), scope, commitment, signingKeyHash: keyHash });
    const status = async (q: WorkspaceAnchorQuery) =>
      workspaceAnchorStatus(createChainStatusReader(await options()), q);

    it("reports an active anchor only once it is finalized, then revocation once that is finalized", async () => {
      await write(accounts[0]!, "configureIssuer", [issuer(), scope, keyHash, true]);
      const deadline = BigInt(Math.floor((await chainTime()) / 1000) + 86_400);
      await write(issuer(), "anchor", [hex("d"), scope, hex("c"), deadline]);
      // Written but not yet finalized: unknown at the finalized block.
      expect(await status(query(hex("d")))).toBeNull();
      await mine();
      const active = await status(query(hex("d")));
      expect(active).toMatchObject({ status: "active", validUntil: Number(deadline) * 1000,
        evidence: { source: "chain", chainId: 11155111 } });
      // Structurally the @attest/verifier status port contract.
      const port: CredentialStatus = active!;
      expect(port.evidence.blockHash).toMatch(/^0x[a-f0-9]{64}$/);
      await write(issuer(), "revoke", [hex("d")]);
      expect((await status(query(hex("d"))))?.status).toBe("active");
      await mine();
      expect(await status(query(hex("d")))).toMatchObject({ status: "revoked", reason: "anchor_revoked" });
    });

    it("treats a withdrawn issuer grant or rotated signing key as not active", async () => {
      const deadline = BigInt(Math.floor((await chainTime()) / 1000) + 86_400);
      await write(issuer(), "anchor", [hex("e"), scope, hex("c"), deadline]);
      await write(accounts[0]!, "configureIssuer", [issuer(), scope, hex("f"), true]);
      await mine();
      expect(await status(query(hex("e")))).toMatchObject({ status: "revoked", reason: "issuer_key_changed" });
      await write(accounts[0]!, "configureIssuer", [issuer(), scope, keyHash, false]);
      await mine();
      expect(await status(query(hex("e")))).toMatchObject({ status: "revoked", reason: "issuer_grant_inactive" });
      await write(accounts[0]!, "configureIssuer", [issuer(), scope, keyHash, true]);
      await mine();
      expect((await status(query(hex("e"))))?.status).toBe("active");
    });

    it("reports expiry against the finalized block time", async () => {
      const soon = BigInt(Math.floor((await chainTime()) / 1000) + 30);
      await write(issuer(), "anchor", [hex("7"), scope, hex("c"), soon]);
      await mine();
      expect((await status(query(hex("7"))))?.status).toBe("active");
      await rpc(urlA, "evm_increaseTime", [120]);
      await mine();
      expect(await status(query(hex("7")))).toMatchObject({ status: "expired", reason: "anchor_expired" });
    });

    it("fails closed when the anchor belongs to another issuer, scope or credential", async () => {
      expect(await code(status(query(hex("e"), hex("6"))))).toBe("anchor_mismatch");
      expect(await code(status({ ...query(hex("e")), issuer: accounts[2]! }))).toBe("anchor_mismatch");
      expect(await code(status({ ...query(hex("e")), scope: hex("5") }))).toBe("anchor_mismatch");
    });
  });
});
