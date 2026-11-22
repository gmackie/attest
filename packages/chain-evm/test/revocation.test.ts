import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import type { CredentialStatus } from "@attest/verifier";
import {
  buildRevocationList, deriveRevocationId, nonMembershipProof, publishEpochArgs, readRevocationEpoch, revocationListId,
  revocationRootsAbi, revocationRootsPublisher, revocationStatus, revocationStatusPort, verifyNonMembership,
  verifyRevocationList, viemRevocationClients, type NonMembershipProof, type RevocationList, type RevocationStatusQuery,
} from "../src/revocation";
import { inclusionProof } from "../src/decision-log";
import { createChainStatusReader, publicClientEndpoint, type ChainEndpoint, type ChainStatusReaderOptions } from "../src/status";

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe("revocation identifiers and sorted-tree non-membership", () => {
  it("derives domain-separated identifiers bound to the issuer list, content id and optional salt", async () => {
    const a = await revocationListId("carrier:northwind"), b = await revocationListId("carrier:other");
    const id = await deriveRevocationId({ list: a, contentId: "12345" });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveRevocationId({ list: a, contentId: "12345" })).toBe(id);
    expect(await deriveRevocationId({ list: b, contentId: "12345" })).not.toBe(id);
    expect(await deriveRevocationId({ list: a, contentId: "12346" })).not.toBe(id);
    expect(await deriveRevocationId({ list: a, contentId: "12345", salt: "ab".repeat(16) })).not.toBe(id);
    expect(await code(deriveRevocationId({ list: a, contentId: "1\n2" }))).toBe("invalid_revocation_input");
    expect(await code(deriveRevocationId({ list: a, contentId: "1", salt: "short" }))).toBe("invalid_revocation_input");
  });

  it("canonicalizes the issuer list and rejects non-canonical or mismatched downloads", async () => {
    const ids = Array.from({ length: 9 }, randomId);
    const list = await buildRevocationList([...ids, ids[0]!]);
    expect(list.size).toBe(9);
    expect([...list.ids]).toEqual([...ids].sort());
    expect(await verifyRevocationList(list.ids, list)).toBe(true);
    expect(await verifyRevocationList([...list.ids].reverse(), list)).toBe(false);
    expect(await verifyRevocationList(list.ids.slice(1), { root: list.root, size: 8 })).toBe(false);
    expect(await verifyRevocationList([...list.ids.slice(0, 8), randomId()].sort(), list)).toBe(false);
    expect(await code(buildRevocationList(["XYZ"]))).toBe("invalid_revocation_id");
  });

  it("proves non-membership before, between and after entries, and in empty or single-entry lists", async () => {
    for (const n of [0, 1, 2, 7]) {
      const list = await buildRevocationList(Array.from({ length: n }, randomId));
      for (let k = 0; k < 12; k++) {
        const probe = randomId();
        const proof = (await nonMembershipProof(list, 3, probe))!;
        expect(await verifyNonMembership(probe, proof, list)).toBe(true);
      }
      for (const edge of ["0".repeat(64), "f".repeat(64)]) {
        const proof = (await nonMembershipProof(list, 3, edge))!;
        expect(await verifyNonMembership(edge, proof, list)).toBe(true);
      }
    }
  });

  it("has no non-membership proof for a revoked id, and forged proofs fail", async () => {
    const list = await buildRevocationList(Array.from({ length: 8 }, randomId));
    const revoked = list.ids[4]!;
    expect(await nonMembershipProof(list, 1, revoked)).toBeNull();
    // Reusing a neighbour's proof: the revoked id is not strictly between its bounds.
    const around = (await nonMembershipProof(list, 1, `${revoked.slice(0, 63)}${revoked[63] === "0" ? "1" : "0"}`))!;
    expect(await verifyNonMembership(revoked, around, list)).toBe(false);
    // Skipping the revoked leaf: indices 3 and 5 bound it but are not adjacent.
    const skip: NonMembershipProof = { epoch: 1,
      low: { index: 3, id: list.ids[3]!, path: await inclusionProof(list.ids, 3) },
      high: { index: 5, id: list.ids[5]!, path: await inclusionProof(list.ids, 5) } };
    expect(await verifyNonMembership(revoked, skip, list)).toBe(false);
    // Claiming the id sorts past the end of a shorter list, or that the list is empty.
    const probe = randomId();
    const good = (await nonMembershipProof(list, 1, probe))!;
    expect(await verifyNonMembership(revoked, { epoch: 1 }, list)).toBe(false);
    expect(await verifyNonMembership(probe, good, { root: list.root, size: list.size + 1 })).toBe(false);
    // Tampered path, swapped bounds, a leaf the issuer never committed to.
    const tampered = JSON.parse(JSON.stringify(good)) as NonMembershipProof;
    const side = (tampered.low ?? tampered.high)!;
    side.path = [randomId(), ...side.path.slice(1)];
    expect(await verifyNonMembership(probe, tampered, list)).toBe(false);
    if (good.low && good.high) expect(await verifyNonMembership(probe, { epoch: 1, low: good.high, high: good.low }, list)).toBe(false);
    const fake = await buildRevocationList([randomId(), randomId()]);
    expect(await verifyNonMembership(revoked, (await nonMembershipProof(fake, 1, revoked))!, list)).toBe(false);
  });
});

const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const available = existsSync(binary);
const root = path.resolve(import.meta.dirname, "../../..");
const port = 18905, url = `http://127.0.0.1:${port}`;
const client = () => createPublicClient({ chain: sepolia, transport: http(url) });
const pub = client(), wallet = createWalletClient({ chain: sepolia, transport: http(url) });
let anvil: ChildProcess | undefined, accounts: Address[] = [], address: Address, list: Hex;

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const mine = (blocks = 3) => rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
const chainTime = async () => Number((await pub.getBlock({ blockTag: "latest" })).timestamp) * 1000;
async function readerOptions(over: Partial<ChainStatusReaderOptions> = {}): Promise<ChainStatusReaderOptions> {
  const now = await chainTime();
  return { chainId: 11155111, endpoints: [publicClientEndpoint("primary", client()), publicClientEndpoint("secondary", client())],
    finality: { kind: "finalized" }, maxBlockAgeMs: 30 * 86_400_000, now: () => now, ...over };
}
const statusReader = async (over: Partial<ChainStatusReaderOptions> = {}) => createChainStatusReader(await readerOptions(over));
const publisher = (account: Address, chainId = 11155111) =>
  revocationRootsPublisher({ clients: viemRevocationClients(pub, wallet, account, chainId), address, list, confirmations: 1 });
async function revertReason(account: Address, functionName: string, args: readonly unknown[]) {
  try {
    await pub.simulateContract({ address, abi: revocationRootsAbi, account, functionName: functionName as never, args: args as never });
    return "ok";
  } catch (e) {
    const m = String((e as Error).message).match(/reverted with the following reason:\s*\n?(.*)/);
    return m?.[1]?.trim() ?? String(e).slice(0, 200);
  }
}
async function send(account: Address, functionName: string, args: readonly unknown[]) {
  const sim = await pub.simulateContract({ address, abi: revocationRootsAbi, account, functionName: functionName as never, args: args as never });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
}

const HOUR = 3_600_000;
beforeAll(async () => {
  if (!available) return;
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], { cwd: path.join(root, "contracts"), encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  // One-slot epochs: "finalized" trails "latest" by two blocks.
  anvil = spawn(binary, ["--port", String(port), "--chain-id", "11155111", "--slots-in-an-epoch", "1", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100 && accounts.length === 0; i++) {
    try { accounts = await wallet.getAddresses(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (accounts.length < 3) throw new Error("Anvil failed to start");
  const artifact = JSON.parse(readFileSync(path.join(root, "contracts/artifacts/RevocationRoots.json"), "utf8"));
  const tx = await wallet.deployContract({ account: accounts[0]!, abi: artifact.abi, bytecode: artifact.bytecode, args: [accounts[0]!] });
  address = (await pub.waitForTransactionReceipt({ hash: tx })).contractAddress!;
  list = await revocationListId("carrier:northwind");
  await send(accounts[0]!, "setPublisher", [list, accounts[1]!]);
  await mine();
}, 60_000);
afterAll(() => anvil?.kill());

describe.skipIf(!available)("RevocationRoots", () => {
  const issuer = () => accounts[1]!;
  const contentId = "4242";
  let mine1: string, others: string[], epoch1: RevocationList, epoch2: RevocationList;
  const query = (evidence: RevocationStatusQuery["evidence"], over: Partial<RevocationStatusQuery> = {}): RevocationStatusQuery =>
    ({ address, list, revocationId: mine1, maxEpochAgeMs: 24 * HOUR, evidence, ...over });
  const asList = (l: RevocationList) => async () => ({ kind: "list" as const, ids: l.ids });

  it("only the registered issuer publishes, epochs are strictly sequential, and a missing list is unavailable", async () => {
    mine1 = await deriveRevocationId({ list, contentId });
    others = Array.from({ length: 5 }, randomId);
    epoch1 = await buildRevocationList(others);
    expect(await revocationStatus(await statusReader(), query(asList(epoch1)))).toBeNull();
    expect(await revertReason(accounts[2]!, "publishEpoch", publishEpochArgs(list, 1, epoch1))).toBe("not publisher");
    expect(await revertReason(accounts[0]!, "publishEpoch", publishEpochArgs(list, 1, epoch1))).toBe("not publisher");
    expect(await revertReason(issuer(), "setPublisher", [list, issuer()])).toBe("not administrator");
    expect(await revertReason(issuer(), "publishEpoch", publishEpochArgs(list, 2, epoch1))).toBe("epoch out of order");
    expect(await revertReason(issuer(), "publishEpoch", [list, 1n, `0x${"0".repeat(64)}`, 0n])).toBe("empty commitment");
    expect(await code(publisher(issuer()).publish(2, epoch1))).toBe("epoch_out_of_order");
    expect((await publisher(issuer()).publish(1, epoch1)).tx).toMatch(/^0x[0-9a-f]{64}$/);
    // Idempotent re-publish; an epoch can never be rewritten.
    expect((await publisher(issuer()).publish(1, epoch1)).tx).toBeUndefined();
    expect(await code(publisher(issuer()).publish(1, await buildRevocationList([randomId()])))).toBe("epoch_conflict");
    expect(await revertReason(issuer(), "publishEpoch", publishEpochArgs(list, 1, epoch1))).toBe("epoch out of order");
    expect(() => publisher(issuer(), 1)).toThrow("production_writes_disabled");
    await mine();
    const read = await readRevocationEpoch(await statusReader(), { address, list });
    expect(read).toMatchObject({ epoch: 1, root: epoch1.root, size: 5, evidence: { source: "chain", chainId: 11155111 } });
  });

  it("AT-04: a credential active at epoch N is refused once epoch N+1 revoking it is settled", async () => {
    const proofN = (await nonMembershipProof(epoch1, 1, mine1))!;
    const holderProof = (p: NonMembershipProof) => async () => ({ kind: "proof" as const, proof: p });
    const active = await revocationStatus(await statusReader(), query(holderProof(proofN), { credentialValidUntil: Number.MAX_SAFE_INTEGER }));
    expect(active).toMatchObject({ status: "active", epoch: 1 });
    // A status lease no longer than the root's freshness: the verifier caps its result to it.
    expect(active!.validUntil).toBe((await readRevocationEpoch(await statusReader(), { address, list }))!.publishedAt + 24 * HOUR);
    const port: CredentialStatus = active!;
    expect(port.evidence.blockHash).toMatch(/^0x[a-f0-9]{64}$/);

    // The issuer revokes: epoch 2 contains the credential's revocation id.
    epoch2 = await buildRevocationList([...others, mine1]);
    await publisher(issuer()).publish(2, epoch2);
    // Not yet finalized: verifiers still read epoch 1. This is the bounded race window (finality delay).
    expect((await revocationStatus(await statusReader(), query(holderProof(proofN))))?.epoch).toBe(1);
    await mine();
    // Settled: the downloaded list shows revoked; the holder's epoch-1 proof is refused; no epoch-2 proof exists.
    expect(await revocationStatus(await statusReader(), query(asList(epoch2)))).toMatchObject({ status: "revoked", reason: "listed_revoked", epoch: 2 });
    expect(await code(revocationStatus(await statusReader(), query(holderProof(proofN))))).toBe("revocation_epoch_mismatch");
    expect(await nonMembershipProof(epoch2, 2, mine1)).toBeNull();
    expect(await code(revocationStatus(await statusReader(), query(holderProof({ ...proofN, epoch: 2 }))))).toBe("revocation_proof_invalid");
    // A stale copy of epoch 1 does not reproduce epoch 2's root.
    expect(await code(revocationStatus(await statusReader(), query(asList(epoch1))))).toBe("revocation_list_mismatch");
    // An unrelated credential stays active under epoch 2.
    const other = await deriveRevocationId({ list, contentId: "7" });
    expect((await revocationStatus(await statusReader(), query(async (e) => ({ kind: "proof", proof: (await nonMembershipProof(epoch2, e.epoch, other))! }), { revocationId: other })))?.status).toBe("active");
  });

  it("refuses roots older than the verifier's maximum staleness, so withholding epoch N+1 stops working", async () => {
    const other = await deriveRevocationId({ list, contentId: "8" });
    const q = (maxEpochAgeMs: number) => query(asList(epoch2), { revocationId: other, maxEpochAgeMs });
    expect((await revocationStatus(await statusReader(), q(HOUR)))?.status).toBe("active");
    // The issuer stops publishing; chain time moves on past the verifier's bound.
    await rpc("evm_increaseTime", [2 * 3600]);
    await mine();
    expect(await code(revocationStatus(await statusReader(), q(HOUR)))).toBe("revocation_root_stale");
    expect((await revocationStatus(await statusReader(), q(24 * HOUR)))?.status).toBe("active");
    // Publishing a fresh (even unchanged) epoch restores availability.
    await publisher(issuer()).publish(3, epoch2);
    await mine();
    expect(await revocationStatus(await statusReader(), q(HOUR))).toMatchObject({ status: "active", epoch: 3 });
  });

  it("as the verifier status port: disagreeing RPCs, a reorg or a stale root are unavailable, never active", async () => {
    const errors: string[] = [];
    const port = async (reader: Awaited<ReturnType<typeof statusReader>>, maxEpochAgeMs = 24 * HOUR) => revocationStatusPort({
      reader, address, maxEpochAgeMs,
      listFor: async (issuerId) => (issuerId === "carrier:northwind" ? list : null),
      evidence: async (_q, e) => ({ kind: "list", ids: e.epoch >= 2 ? epoch2.ids : epoch1.ids }),
      onError: (e) => errors.push((e as { code?: string }).code ?? String(e)),
    })({ credentialIssuer: "carrier:northwind", schema: "s", contentId: "9" });
    expect((await port(await statusReader()))?.status).toBe("active");
    expect(await port(await statusReader())).not.toHaveProperty("reason");
    // The revoked credential through the port.
    expect(await revocationStatusPort({ reader: await statusReader(), address, maxEpochAgeMs: 24 * HOUR, listFor: async () => list,
      evidence: async () => ({ kind: "list", ids: epoch2.ids }) })({ credentialIssuer: "x", schema: "s", contentId })).toMatchObject({ status: "revoked" });
    expect(await revocationStatusPort({ reader: await statusReader(), address, maxEpochAgeMs: 24 * HOUR, listFor: async () => null,
      evidence: async () => ({ kind: "list", ids: [] }) })({ credentialIssuer: "unknown", schema: "s", contentId })).toBeNull();

    const base = await readerOptions();
    const forged: ChainEndpoint = { name: "forged", client: { ...base.endpoints[1]!.client,
      readContract: async (args) => {
        const r = (await base.endpoints[1]!.client.readContract(args)) as unknown[];
        return [r[0], `0x${(await buildRevocationList([])).root}`, 0n, r[3]];
      } } };
    expect(await port(createChainStatusReader({ ...base, endpoints: [base.endpoints[0]!, forged] }))).toBeNull();
    expect(errors.pop()).toBe("rpc_disagreement");

    const confirmed = await statusReader({ finality: { kind: "confirmations", confirmations: 1 } });
    let reorg: Promise<unknown> | undefined;
    const reorging = (e: ChainEndpoint): ChainEndpoint => ({ name: e.name, client: { ...e.client,
      readContract: async (args) => { reorg ??= rpc("anvil_reorg", [2, []]); await reorg; return e.client.readContract(args); } } });
    const snap = await confirmed.snapshot();
    const reorgReader = createChainStatusReader({ ...confirmed.options, endpoints: confirmed.options.endpoints.map(reorging) });
    expect(await code(revocationStatus(reorgReader, query(asList(epoch2), { revocationId: randomId() }), snap))).toBe("reorg_detected");

    await rpc("evm_increaseTime", [48 * 3600]);
    await mine();
    expect(await port(await statusReader())).toBeNull();
    expect(errors.pop()).toBe("revocation_root_stale");
  });
});
