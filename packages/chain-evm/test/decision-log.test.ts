import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import {
  anchorEpochArgs, decisionLogAnchorAbi, decisionLogAnchorAdapter, decisionLogId, inclusionProof, merkleRoot,
  readAnchoredEpoch, verifyAnchoredInclusion, verifyInclusion, viemAnchorClients, type SealedEpoch,
} from "../src/decision-log";
import { createChainStatusReader, publicClientEndpoint } from "../src/status";
import { deployNetwork } from "../scripts/deploy-network.mjs";
import { anvilAvailable as available, anvilBinary as binary, anvilNetworks } from "./anvil-networks";

describe("RFC 6962 Merkle hashing", () => {
  // RFC 6962 test vectors (also used by Gatekeeper's tests/ledger.test.ts).
  const leaves = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"];
  const roots = ["6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d", "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77", "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4", "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
    "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c", "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328"];
  it("matches the vectors, and every proof verifies only for its own leaf, index and size", async () => {
    expect(await merkleRoot([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    for (let n = 1; n <= 8; n++) {
      expect(await merkleRoot(leaves.slice(0, n))).toBe(roots[n - 1]);
      for (let i = 0; i < n; i++) {
        const p = await inclusionProof(leaves.slice(0, n), i);
        expect(await verifyInclusion(leaves[i]!, i, n, p, roots[n - 1]!)).toBe(true);
        if (n > 1) expect(await verifyInclusion(leaves[(i + 1) % n]!, i, n, p, roots[n - 1]!)).toBe(false);
      }
    }
  });
});

const root = path.resolve(import.meta.dirname, "../../..");
/** Anvil's first default account (public test key). */
const anvilKey0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe.each(anvilNetworks)("on $network.name", ({ network, offset }) => {
const chainId = network.chainId;
const port = 18895 + offset, url = `http://127.0.0.1:${port}`;
const reader = createPublicClient({ chain: network.chain, transport: http(url) });
const wallet = createWalletClient({ chain: network.chain, transport: http(url) });
let anvil: ChildProcess | undefined, accounts: Address[] = [], address: Address, log: Hex;

const randomHash = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
/** A hash-chained span like Gatekeeper's ledger: returns leaves and the sealed epoch. */
async function span(epoch: number, firstSeq: number, count: number, prev: string) {
  const leaves = Array.from({ length: count }, randomHash);
  const sealed: SealedEpoch = { epoch, root: await merkleRoot(leaves), firstSeq, lastSeq: firstSeq + count - 1, size: count,
    firstPrevHash: prev, lastLeafHash: leaves[count - 1]! };
  return { leaves, sealed };
}
const statusReader = () => createChainStatusReader({
  chainId, endpoints: [publicClientEndpoint("a", reader), publicClientEndpoint("b", createPublicClient({ chain: network.chain, transport: http(url) }))],
  finality: { kind: "confirmations", confirmations: 1 }, maxBlockAgeMs: 3_600_000, now: () => Date.now(),
});
const adapter = (account: Address, adapterChainId: number = chainId) =>
  decisionLogAnchorAdapter({ clients: viemAnchorClients(reader, wallet, account, adapterChainId), address, log, confirmations: 1 });
async function revertReason(account: Address, functionName: string, args: readonly unknown[]) {
  try {
    await reader.simulateContract({ address, abi: decisionLogAnchorAbi, account, functionName: functionName as never, args: args as never });
    return "ok";
  } catch (e) {
    const m = String((e as Error).message).match(/reverted with the following reason:\s*\n?(.*)/);
    return m?.[1]?.trim() ?? String(e).slice(0, 200);
  }
}
async function send(account: Address, functionName: string, args: readonly unknown[]) {
  const sim = await reader.simulateContract({ address, abi: decisionLogAnchorAbi, account, functionName: functionName as never, args: args as never });
  await reader.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

beforeAll(async () => {
  if (!available) return;
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], { cwd: path.join(root, "contracts"), encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  anvil = spawn(binary, ["--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100 && accounts.length === 0; i++) {
    try { accounts = await wallet.getAddresses(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  // Deployed by the same script operators use for a new network (scripts/deploy-network.mjs).
  const manifest = await deployNetwork({ network: network.id, privateKey: anvilKey0, rpcUrl: url, confirmations: 1 });
  expect(manifest).toMatchObject({ network: network.id, chainId, deployer: accounts[0] });
  address = manifest.contracts.DecisionLogAnchor.default;
  log = await decisionLogId("gatekeeper.example/decision-ledger");
  await send(accounts[0]!, "setPublisher", [log, accounts[1]!]);
}, 60_000);
afterAll(() => anvil?.kill());

describe.skipIf(!available)("DecisionLogAnchor", () => {
  let first: Awaited<ReturnType<typeof span>>;

  it("anchors a sealed epoch, and a third party verifies every receipt against the root read back from chain", async () => {
    first = await span(1, 1, 5, "0".repeat(64));
    const receipt = await adapter(accounts[1]!).anchor(first.sealed);
    expect(receipt.ref).toMatch(new RegExp(`^eip155:${chainId}:0x[0-9a-f]{40}:0x[0-9a-f]{64}:tx:0x[0-9a-f]{64}@\\d+$`));
    const anchored = await readAnchoredEpoch(statusReader(), { address, log, epoch: 1 });
    expect(anchored).toMatchObject({ epoch: 1, root: first.sealed.root, firstSeq: 1, lastSeq: 5, size: 5,
      firstPrevHash: "0".repeat(64), lastLeafHash: first.sealed.lastLeafHash, evidence: { source: "chain", chainId } });
    for (let i = 0; i < 5; i++) {
      const p = await inclusionProof(first.leaves, i);
      expect(await verifyAnchoredInclusion(anchored!, { seq: 1 + i, leafHash: first.leaves[i]!, path: p })).toBe(true);
      // Wrong sequence number, or a leaf the operator never anchored, does not verify.
      expect(await verifyAnchoredInclusion(anchored!, { seq: 1 + ((i + 1) % 5), leafHash: first.leaves[i]!, path: p })).toBe(false);
      expect(await verifyAnchoredInclusion(anchored!, { seq: 1 + i, leafHash: randomHash(), path: p })).toBe(false);
    }
    expect(await readAnchoredEpoch(statusReader(), { address, log, epoch: 2 })).toBeNull();
  });

  it("is idempotent for the same epoch and refuses to overwrite it with a different commitment", async () => {
    expect((await adapter(accounts[1]!).anchor(first.sealed)).ref).toMatch(/:epoch:1$/);
    expect(await code(adapter(accounts[1]!).anchor({ ...first.sealed, root: randomHash() }))).toBe("anchor_conflict");
    expect(await revertReason(accounts[1]!, "anchorEpoch", anchorEpochArgs(log, { ...first.sealed, root: randomHash() }))).toBe("epoch out of order");
  });

  it("rejects gaps, forks and out-of-order epochs on-chain", async () => {
    const next = await span(2, 6, 3, first.sealed.lastLeafHash);
    expect(await revertReason(accounts[1]!, "anchorEpoch", anchorEpochArgs(log, { ...next.sealed, firstSeq: 7, lastSeq: 9 }))).toBe("sequence gap");
    expect(await revertReason(accounts[1]!, "anchorEpoch", anchorEpochArgs(log, { ...next.sealed, firstPrevHash: randomHash() }))).toBe("chain fork");
    expect(await code(adapter(accounts[1]!).anchor({ ...next.sealed, epoch: 3 }))).toBe("anchor_out_of_order");
    await adapter(accounts[1]!).anchor(next.sealed);
    expect((await readAnchoredEpoch(statusReader(), { address, log, epoch: 2 }))?.firstPrevHash).toBe(first.sealed.lastLeafHash);
  });

  it("enforces genesis rules for a new log", async () => {
    const other = await decisionLogId("other-log");
    await send(accounts[0]!, "setPublisher", [other, accounts[1]!]);
    const g = await span(1, 1, 2, "0".repeat(64));
    expect(await revertReason(accounts[1]!, "anchorEpoch", anchorEpochArgs(other, { ...g.sealed, firstSeq: 2, lastSeq: 3 }))).toBe("genesis");
    expect(await revertReason(accounts[1]!, "anchorEpoch", anchorEpochArgs(other, { ...g.sealed, firstPrevHash: randomHash() }))).toBe("genesis");
  });

  it("only the current publisher can anchor; the administrator can rotate it", async () => {
    const third = await span(3, 9, 2, (await readAnchoredEpoch(statusReader(), { address, log, epoch: 2 }))!.lastLeafHash);
    expect(await revertReason(accounts[2]!, "anchorEpoch", anchorEpochArgs(log, third.sealed))).toBe("not publisher");
    expect(await revertReason(accounts[1]!, "setPublisher", [log, accounts[2]!])).toBe("not administrator");
    await send(accounts[0]!, "setPublisher", [log, accounts[2]!]);
    expect(await revertReason(accounts[1]!, "anchorEpoch", anchorEpochArgs(log, third.sealed))).toBe("not publisher");
    await adapter(accounts[2]!).anchor(third.sealed);
  });

  it("hands over administration in two steps", async () => {
    await send(accounts[0]!, "proposeAdministrator", [accounts[3]!]);
    expect(await revertReason(accounts[4]!, "acceptAdministrator", [])).toBe("not proposed");
    await send(accounts[3]!, "acceptAdministrator", []);
    expect(await reader.readContract({ address, abi: decisionLogAnchorAbi, functionName: "administrator" })).toBe(accounts[3]);
    expect(await revertReason(accounts[0]!, "setPublisher", [log, accounts[0]!])).toBe("not administrator");
  });

  it("refuses to publish to Ethereum mainnet while production writes are gated", () => {
    expect(() => adapter(accounts[1]!, 1)).toThrow("production_writes_disabled");
    // Unknown (for example Base mainnet) chains fail closed too.
    expect(() => adapter(accounts[1]!, 8453)).toThrow("network_not_writable");
  });

  it("deploy-network refuses a signer whose RPC reports another chain", async () => {
    const other = network.id === "sepolia" ? "base-sepolia" : "sepolia";
    await expect(deployNetwork({ network: other, privateKey: anvilKey0, rpcUrl: url, confirmations: 1 })).rejects.toThrow("chain_mismatch");
  });
});
});
