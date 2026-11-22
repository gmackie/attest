import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import type { CredentialStatus } from "@attest/verifier";
import {
  MANDATE_SCHEMA, documentDigest, issueMandate, keyThumbprint, verifyPresentation,
  type AgentMandate, type VerificationPorts,
} from "@attest/mandates";
import {
  mandateCredentialStatus, mandateStatusRegistry, readStatusRecord, statusRefId, statusRegistryAbi, viemStatusClients,
} from "../src/mandate-status";
import { createChainStatusReader, publicClientEndpoint, type ChainEndpoint, type ChainStatusReaderOptions } from "../src/status";

const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const available = existsSync(binary);
const root = path.resolve(import.meta.dirname, "../../..");
const portA = 18905, portB = 18906;
const urlA = `http://127.0.0.1:${portA}`, urlB = `http://127.0.0.1:${portB}`;
const client = (url: string) => createPublicClient({ chain: sepolia, transport: http(url) });
const pub = client(urlA), wallet = createWalletClient({ chain: sepolia, transport: http(urlA) });
let anvils: ChildProcess[] = [], accounts: Address[] = [], registry: Address;
let clock = 0;

async function rpc(url: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const mine = (blocks = 2) => rpc(urlA, "anvil_mine", [`0x${blocks.toString(16)}`]);
const chainTime = async () => Number((await pub.getBlock({ blockTag: "latest" })).timestamp) * 1000;
const code = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e).slice(0, 200); }
};
async function revertReason(account: Address, functionName: string, args: readonly unknown[]) {
  try {
    await pub.simulateContract({ address: registry, abi: statusRegistryAbi, account, functionName: functionName as never, args: args as never });
    return "ok";
  } catch (e) {
    const m = String((e as Error).message).match(/reverted with the following reason:\s*\n?(.*)/);
    return m?.[1]?.trim() ?? String(e).slice(0, 200);
  }
}
async function send(account: Address, functionName: string, args: readonly unknown[]) {
  const sim = await pub.simulateContract({ address: registry, abi: statusRegistryAbi, account, functionName: functionName as never, args: args as never });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
}
const readerOptions = (over: Partial<ChainStatusReaderOptions> = {}): ChainStatusReaderOptions => ({
  chainId: 11155111,
  endpoints: [publicClientEndpoint("primary", client(urlA)), publicClientEndpoint("secondary", client(urlA))],
  finality: { kind: "confirmations", confirmations: 2 }, maxBlockAgeMs: 3_600_000, now: () => clock, ...over,
});
const reader = (over: Partial<ChainStatusReaderOptions> = {}) => createChainStatusReader(readerOptions(over));
const issuer = () => accounts[1]!;
const service = (over: Partial<Parameters<typeof mandateStatusRegistry>[0]> = {}) => mandateStatusRegistry({
  registry, issuer: issuer(), reader: reader(), confirmations: 1,
  writer: viemStatusClients(pub, wallet, issuer(), 11155111), ...over,
});
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { private: await crypto.subtle.exportKey("jwk", pair.privateKey), public: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}
/** A signed mandate whose status is read from the on-chain registry. */
async function fixture(statusRef: string, status: VerificationPorts["status"]) {
  const human = await keys(), agent = await keys();
  const mandate: AgentMandate = {
    schema: MANDATE_SCHEMA, id: statusRef, issuer: "authority:alice", subject: "user:alice", tenant: "shop",
    delegate: { clientId: "https://atlas.example/agent.json", keyThumbprint: await keyThumbprint(agent.public) },
    audience: "https://shop.example/poppy", actions: ["orders.exchange"],
    constraints: { resources: ["order:7"], purposes: ["CustomerSupport"], terms: {} },
    issuedAt: clock - 1000, validFrom: clock - 1000, validUntil: clock + 3_600_000,
    statusRef, mayDelegate: false, maxDelegationDepth: 0,
  };
  const ports: VerificationPorts = {
    resolveKey: async (iss, kid) => (iss === mandate.issuer && kid === "key1" ? human.public : null),
    authorizedIssuer: async (iss, subject) => iss === mandate.issuer && subject === mandate.subject,
    status, now: () => clock, maxStatusAgeMs: 60_000,
  };
  const token = await run(issueMandate(mandate, "key1", human.private));
  return { mandate, ports, token, verify: () => run(verifyPresentation([token], ports)) };
}

beforeAll(async () => {
  if (!available) return;
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], { cwd: path.join(root, "contracts"), encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  for (const port of [portA, portB])
    anvils.push(spawn(binary, ["--port", String(port), "--chain-id", "11155111", "--silent"], { stdio: "ignore" }));
  for (let i = 0; i < 100 && accounts.length === 0; i++) {
    try { accounts = await wallet.getAddresses(); await client(urlB).getChainId(); }
    catch { accounts = []; await new Promise((r) => setTimeout(r, 100)); }
  }
  if (accounts.length < 3) throw new Error("Anvil failed to start");
  const artifact = JSON.parse(readFileSync(path.join(root, "contracts/artifacts/StatusRegistry.json"), "utf8"));
  const tx = await wallet.deployContract({ account: accounts[0]!, abi: artifact.abi, bytecode: artifact.bytecode });
  registry = (await pub.waitForTransactionReceipt({ hash: tx })).contractAddress!;
  await mine();
  clock = await chainTime();
}, 60_000);
afterAll(() => anvils.forEach((a) => a.kill()));

describe.skipIf(!available)("StatusRegistry contract", () => {
  const ref = `0x${"1".repeat(64)}` as Hex, digest = `0x${"d".repeat(64)}` as Hex, other = `0x${"e".repeat(64)}` as Hex;
  const later = async () => BigInt(Math.floor((await chainTime()) / 1000) + 3600);

  it("registers once per issuer namespace and emits an event for every transition", async () => {
    await send(issuer(), "register", [ref, digest, await later()]);
    expect(await revertReason(issuer(), "register", [ref, digest, await later()])).toBe("already registered");
    expect(await revertReason(issuer(), "register", [ref, other, await later()])).toBe("already registered");
    expect(await revertReason(issuer(), "register", [`0x${"0".repeat(64)}`, digest, await later()])).toBe("ref");
    expect(await revertReason(issuer(), "register", [`0x${"2".repeat(64)}`, `0x${"0".repeat(64)}`, await later()])).toBe("digest");
    expect(await revertReason(issuer(), "register", [`0x${"2".repeat(64)}`, digest, 1n])).toBe("expired");
    const registered = await pub.getContractEvents({ address: registry, abi: statusRegistryAbi, eventName: "StatusRegistered", fromBlock: 0n });
    expect(registered.at(-1)?.args).toMatchObject({ issuer: issuer(), ref, digest });
  });

  it("only the issuer can transition its record; a non-issuer write reverts and changes nothing", async () => {
    // Another account addresses its own, empty namespace.
    expect(await revertReason(accounts[2]!, "revoke", [ref])).toBe("unknown ref");
    expect(await revertReason(accounts[2]!, "supersede", [ref, `0x${"3".repeat(64)}`])).toBe("successor not active");
    // A non-issuer can register the same ref only in its own namespace; the issuer's record is untouched.
    await send(accounts[2]!, "register", [ref, other, await later()]);
    const record = await pub.readContract({ address: registry, abi: statusRegistryAbi, functionName: "getStatus", args: [issuer(), ref] });
    expect(record).toMatchObject({ digest, status: 1 });
  });

  it("is one-way: revoked never returns to active and supersede needs an active successor", async () => {
    const successor = `0x${"4".repeat(64)}` as Hex;
    expect(await revertReason(issuer(), "supersede", [ref, `0x${"0".repeat(64)}`])).toBe("successor");
    expect(await revertReason(issuer(), "supersede", [ref, ref])).toBe("successor");
    expect(await revertReason(issuer(), "supersede", [ref, successor])).toBe("successor not active");
    await send(issuer(), "revoke", [ref]);
    expect(await revertReason(issuer(), "revoke", [ref])).toBe("not active");
    expect(await revertReason(issuer(), "register", [ref, digest, await later()])).toBe("already registered");
    await send(issuer(), "register", [successor, other, await later()]);
    expect(await revertReason(issuer(), "supersede", [ref, successor])).toBe("not active");
    const revoked = await pub.getContractEvents({ address: registry, abi: statusRegistryAbi, eventName: "StatusRevoked", fromBlock: 0n });
    expect(revoked.map((e) => e.args.ref)).toContain(ref);

    const old = `0x${"5".repeat(64)}` as Hex;
    await send(issuer(), "register", [old, digest, await later()]);
    await send(issuer(), "supersede", [old, successor]);
    expect(await revertReason(issuer(), "revoke", [old])).toBe("not active");
    expect(await revertReason(issuer(), "supersede", [old, successor])).toBe("not active");
    const superseded = await pub.getContractEvents({ address: registry, abi: statusRegistryAbi, eventName: "StatusSuperseded", fromBlock: 0n });
    expect(superseded.at(-1)?.args).toMatchObject({ issuer: issuer(), ref: old, successor });
  });
});

describe.skipIf(!available)("mandate status over StatusRegistry", () => {
  it("verifies an active mandate only once its registration is settled, and binds the lease to ≤ 60 s", async () => {
    const reg = service();
    const f = await fixture("status:settled", reg.status);
    const digest = await run(reg.register(f.mandate));
    expect(digest).toBe(await documentDigest(f.mandate));
    // Mined but not yet at two confirmations.
    expect(await code(f.verify())).toBe("status_unavailable");
    await mine();
    clock = await chainTime();
    const chain = await f.verify();
    expect(chain.expiresAt).toBeLessThanOrEqual(clock + 5000);
    const live = await run(reg.read(f.mandate.statusRef, digest, 60_000));
    expect(live).toMatchObject({ status: "active", observedAt: clock, validUntil: clock + 60_000 });
    expect(await code(run(reg.read(f.mandate.statusRef, digest, 60_001)))).toBe("invalid_status_lease");
    // Nothing readable about the mandate reaches the chain: only the hashed ref and the digest.
    const record = await readStatusRecord(reader(), { registry, issuer: issuer(), ref: await statusRefId(f.mandate.statusRef) });
    expect(record.record).toMatchObject({ digest, status: "active" });
  });

  it("refuses the next operation after an on-chain revoke; a cached active lasts only until its lease ends", async () => {
    const fresh = service(), cached = service({ cacheActive: true, leaseMs: 5000 });
    const f = await fixture("status:revoke", fresh.status);
    await run(fresh.register(f.mandate));
    await mine();
    clock = await chainTime();
    await f.verify();
    await run(cached.read(f.mandate.statusRef, await documentDigest(f.mandate)));
    await run(fresh.revoke(f.mandate.statusRef));
    await mine();
    // Uncached: the very next operation reads the settled revocation.
    expect(await code(f.verify())).toBe("status_unavailable");
    expect((await run(fresh.read(f.mandate.statusRef, await documentDigest(f.mandate))))?.status).toBe("revoked");
    // Cached: the earlier active observation is reused until observedAt + lease, never beyond.
    const base = clock;
    clock = base + 4999;
    expect(await code(cached.status(f.mandate.statusRef, await documentDigest(f.mandate)))).toBe("ok");
    clock = base + 5000;
    expect((await cached.status(f.mandate.statusRef, await documentDigest(f.mandate)))?.status).toBe("revoked");
    clock = base;
    // Re-issuing never resurrects; a second revoke is a no-op, matching LocalStatusRegistry.
    expect(await run(fresh.register(f.mandate))).toBe(await documentDigest(f.mandate));
    await run(fresh.revoke(f.mandate.statusRef));
    await mine();
    expect((await run(fresh.read(f.mandate.statusRef, await documentDigest(f.mandate))))?.status).toBe("revoked");
  });

  it("refuses a digest mismatch, an unknown ref and another issuer's record", async () => {
    const reg = service();
    const f = await fixture("status:digest", reg.status);
    const digest = await run(reg.register(f.mandate));
    await mine();
    expect(await run(reg.read(f.mandate.statusRef, "a".repeat(64)))).toBeNull();
    expect(await run(reg.read("status:never-registered", digest))).toBeNull();
    // Rebinding the ref to a different document is refused before any write.
    expect(await code(run(reg.register({ ...f.mandate, subject: "user:bob" })))).toBe("status_ref_already_bound");
    // A verifier pinned to another issuer account sees nothing.
    const stranger = mandateStatusRegistry({ registry, issuer: accounts[2]!, reader: reader() });
    expect(await run(stranger.read(f.mandate.statusRef, digest))).toBeNull();
    const g = await fixture("status:unknown", reg.status);
    expect(await code(g.verify())).toBe("status_unavailable");
    expect(await code(run(reg.revoke("status:never-registered")))).toBe("status_ref_unknown");
    expect(() => mandateStatusRegistry({ registry, issuer: issuer(), reader: reader(),
      writer: viemStatusClients(pub, wallet, accounts[2]!, 11155111) })).toThrow("writer_not_issuer");
  });

  it("supersedes only to a registered successor", async () => {
    const reg = service();
    const f = await fixture("status:v1", reg.status), next = await fixture("status:v2", reg.status);
    await run(reg.register(f.mandate));
    expect(await code(run(reg.supersede("status:v1", "status:v2")))).toBe("invalid_status_transition");
    expect(await code(run(reg.supersede("status:v1", "status:v1")))).toBe("invalid_status_transition");
    await run(reg.register(next.mandate));
    await run(reg.supersede("status:v1", "status:v2"));
    await mine();
    clock = await chainTime();
    expect((await run(reg.read("status:v1", await documentDigest(f.mandate))))?.status).toBe("superseded");
    expect(await code(f.verify())).toBe("status_unavailable");
    await next.verify();
    // Superseded is terminal: revoke is a no-op and the record stays superseded.
    await run(reg.revoke("status:v1"));
    const status = await mandateCredentialStatus(reader(), { registry, issuer: issuer(),
      ref: await statusRefId("status:v1"), digest: await documentDigest(f.mandate) });
    expect(status).toMatchObject({ status: "superseded", successor: await statusRefId("status:v2") });
  });

  it("fails closed, never active, when RPCs disagree, a reorg replaces the block or the head is stale", async () => {
    const f0 = await fixture("status:rpc", async () => null);
    await run(service().register(f0.mandate));
    await mine();
    clock = await chainTime();
    const digest = await documentDigest(f0.mandate);
    const base = readerOptions();
    const forged: ChainEndpoint = { name: "forged", client: { ...base.endpoints[1]!.client,
      readContract: async (args) => ({ ...(await base.endpoints[1]!.client.readContract(args) as object), status: 2 }) } };
    const split = service({ reader: createChainStatusReader({ ...base, endpoints: [base.endpoints[0]!, forged] }) });
    expect(await code(run(split.read("status:rpc", digest)))).toBe("rpc_disagreement");
    expect(await code(split.status("status:rpc", digest))).toBe("status_unavailable");
    const f = await fixture("status:rpc", split.status);
    expect(await code(f.verify())).toBe("status_unavailable");

    // Endpoints following different chains.
    const forked = service({ reader: createChainStatusReader({ ...base,
      endpoints: [base.endpoints[0]!, publicClientEndpoint("other", client(urlB))] }) });
    expect(await code(run(forked.read("status:rpc", digest)))).not.toBe("ok");

    const stale = service({ reader: reader({ now: () => clock + 7_200_000 }) });
    expect(await code(run(stale.read("status:rpc", digest)))).toBe("chain_stale");

    // Both endpoints wait for one reorg, so they agree on the replaced block's state and only the
    // post-read block-hash check can catch it.
    let reorg: Promise<unknown> | undefined;
    const reorging = (e: ChainEndpoint): ChainEndpoint => ({ name: e.name, client: { ...e.client,
      readContract: async (args) => { reorg ??= rpc(urlA, "anvil_reorg", [3, []]); await reorg; return e.client.readContract(args); } } });
    const r = service({ reader: createChainStatusReader({ ...base, endpoints: base.endpoints.map(reorging) }) });
    expect(await code(run(r.read("status:rpc", digest)))).toBe("reorg_detected");
    reorg = undefined;
    expect(await code(r.status("status:rpc", digest))).toBe("status_unavailable");
  });

  it("exposes the verifier CredentialStatus shape with chain evidence and lease-capped validity", async () => {
    const reg = service();
    const f = await fixture("status:credential", reg.status);
    const digest = await run(reg.register(f.mandate));
    await mine();
    clock = await chainTime();
    const query = { registry, issuer: issuer(), ref: await statusRefId("status:credential"), digest };
    const active = await mandateCredentialStatus(reader(), query, { leaseMs: 30_000 });
    const port: CredentialStatus = active!;
    expect(port).toMatchObject({ status: "active", validUntil: clock + 30_000, evidence: { source: "chain", chainId: 11155111 } });
    expect(port.evidence.blockHash).toMatch(/^0x[a-f0-9]{64}$/);
    await expect(mandateCredentialStatus(reader(), { ...query, digest: "a".repeat(64) })).rejects.toMatchObject({ code: "status_digest_mismatch" });
    expect(await mandateCredentialStatus(reader(), { ...query, ref: await statusRefId("status:none") })).toBeNull();
    await run(reg.revoke("status:credential"));
    await mine();
    expect((await mandateCredentialStatus(reader(), query))?.status).toBe("revoked");
  });

  it("reports expiry against the settled block time", async () => {
    const reg = service();
    const f = await fixture("status:expiring", reg.status);
    const short = { ...f.mandate, validUntil: clock + 30_000 };
    const digest = await run(reg.register(short));
    await mine();
    const query = { registry, issuer: issuer(), ref: await statusRefId("status:expiring"), digest };
    expect((await mandateCredentialStatus(reader(), query))?.status).toBe("active");
    await rpc(urlA, "evm_increaseTime", [120]);
    await mine();
    clock = await chainTime();
    expect((await mandateCredentialStatus(reader(), query))?.status).toBe("expired");
    expect(await run(reg.read("status:expiring", digest))).toBeNull();
  });

  it("refuses to write to Ethereum mainnet while production writes are gated", () => {
    expect(() => viemStatusClients(pub, wallet, issuer(), 1)).toThrow("production_writes_disabled");
    expect(() => mandateStatusRegistry({ registry, issuer: issuer(), reader: reader(),
      writer: { ...viemStatusClients(pub, wallet, issuer(), 11155111), chainId: 1 } })).toThrow("production_writes_disabled");
  });
});
