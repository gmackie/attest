/**
 * Demo PEP epochs anchored on DecisionLogAnchor, against anvil with Sepolia's chain id (as the
 * chain-evm suites do): seal → alarm publish → epoch anchored → the browser verifies the receipt
 * against the root read back from chain. Negative: unauthorized publisher, chain mismatch,
 * tampered receipt, misconfiguration.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import {
  createChainStatusReader, decisionLogAnchorAbi, decisionLogId, networkConfigs, publicClientEndpoint,
  type AnchorPublisherClients,
} from "@attest/chain-evm";
import { deployNetwork } from "../../../packages/chain-evm/scripts/deploy-network.mjs";
import { anvilAvailable, anvilBinary } from "../../../packages/chain-evm/test/anvil-networks";
import { createDemoPep, type DemoPepEnvWithLimits } from "../src/demo-pep/pep";
import { anchorSetup, MAX_FEE_PER_GAS, publisherClients, type AnchorConfig, type AnchorState } from "../src/demo-pep/anchor";
import type { EpochRow } from "../src/demo-pep/ledger";
import { receiptVerdict, verifyAgainstChain, verifyReceipt, type ReceiptResponse } from "../../../packages/demo/src/vendor-portal";
import { MemoryStore } from "./memory-store";

const sepolia = networkConfigs.sepolia;
const port = 18995, url = `http://127.0.0.1:${port}`;
const anvilKey0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** anvil account 1: the authorized publisher. */
const publisherKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** anvil account 2: never authorized. */
const strangerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const LOG_ID = "0x6b0b609dfc1698b1d74ce391632963f26f2e8e658f85b133594967a3145a054c";

const reader = createPublicClient({ chain: sepolia.chain, transport: http(url) });
const wallet = createWalletClient({ chain: sepolia.chain, transport: http(url) });
let anvil: ChildProcess | undefined, accounts: Address[] = [], address: Address;

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { privateKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! }, publicKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } };
}
let baseEnv: DemoPepEnvWithLimits;
const anchorVar = (over: Partial<AnchorConfig> = {}) => JSON.stringify({ chainId: sepolia.chainId, address, logId: LOG_ID, ...over });
/** In tests the trusted contract is the one deployed on anvil (the browser pins the Sepolia deployment). */
const trust = (chainId: number) => (chainId === sepolia.chainId ? address : null);
const chainReader = () => createChainStatusReader({
  chainId: sepolia.chainId, endpoints: [publicClientEndpoint("a", reader),
    publicClientEndpoint("b", createPublicClient({ chain: sepolia.chain, transport: http(url) }))],
  finality: { kind: "confirmations", confirmations: 1 }, maxBlockAgeMs: 3_600_000, now: () => Date.now(),
});

/** A PEP whose publisher talks to anvil; `wrap` lets a test observe or corrupt the clients. */
function pep(wrap: (c: AnchorPublisherClients) => AnchorPublisherClients = (c) => c) {
  let writes = 0;
  const handle = createDemoPep({ anchor: { confirmations: 1, clients: (config, key) => {
    const c = wrap(publisherClients(config, key, { rpcUrls: [url] }));
    return { ...c, simulateAndWrite: (a) => { writes++; return c.simulateAndWrite(a); } };
  } } });
  return { handle, writes: () => writes };
}
async function decisions(h: ReturnType<typeof createDemoPep>, env: DemoPepEnvWithLimits, store: MemoryStore, n: number) {
  const send = (p: string, init: RequestInit = {}) => h(new Request(`https://attest.gmac.io${p}`, init), env, store);
  const tok = (await (await send("/api/demo-pep/identity/token", { method: "POST" })).json()) as { access_token: string };
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const body = JSON.stringify({ action: "vendor.payout.approve", resourceId: "supplier:acme" });
    const r = await send("/api/demo-pep/authorize", { method: "POST", body, headers: {
      "content-type": "application/json", "content-length": String(body.length), authorization: `Bearer ${tok.access_token}` } });
    ids.push(((await r.json()) as { decisionId: string }).decisionId);
  }
  const receipt = async (id: string) =>
    (await (await send(`/api/demo-pep/decisions/${id}/receipt`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json()) as ReceiptResponse;
  return { ids, receipt, send };
}

beforeAll(async () => {
  const [pepKey, idKey, verifierKey] = await Promise.all([keyPair(), keyPair(), keyPair()]);
  baseEnv = {
    DEMO_PEP_ISSUER: "https://attest.gmac.io/api/demo-pep",
    DEMO_PEP_VERIFIER: JSON.stringify({ issuer: "https://verify.attest.gmac.io", endpoint: "https://verify.attest.gmac.io/v1/presentations",
      keys: [{ kid: "v1", publicKey: verifierKey.publicKey }],
      requirements: [{ id: "demo.insurance.cgl.min-2m", digest: "2251414534a86a6cbe9b53d6a030b6fbe4437f8d1e7341ec0bc91246846b3d20" }] }),
    DEMO_PEP_SIGNING_KEY: JSON.stringify({ active: "p1", keys: [{ kid: "p1", privateKey: pepKey.privateKey }] }),
    DEMO_IDENTITY_SIGNING_KEY: JSON.stringify({ active: "i1", keys: [{ kid: "i1", privateKey: idKey.privateKey }] }),
  };
  if (!anvilAvailable) return;
  // Sepolia's base fee is ~17 wei; anvil's is pinned low too, so the 1000 wei cap is exercised for real.
  anvil = spawn(anvilBinary, ["--port", String(port), "--chain-id", String(sepolia.chainId), "--base-fee", "7", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100 && accounts.length === 0; i++) {
    try { accounts = await wallet.getAddresses(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  address = (await deployNetwork({ network: "sepolia", privateKey: anvilKey0, rpcUrl: url, confirmations: 1 })).contracts.DecisionLogAnchor.default;
  // The administrator authorizes the publisher for the demo PEP's log (the documented setup step).
  expect(await decisionLogId("attest-demo-pep")).toBe(LOG_ID);
  const sim = await reader.simulateContract({ address, abi: decisionLogAnchorAbi, account: accounts[0]!, functionName: "setPublisher",
    args: [LOG_ID, accounts[1]!] });
  await reader.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
}, 120_000);
afterAll(() => anvil?.kill());

describe("demo PEP anchoring configuration", () => {
  it("is optional, strict, and never exposes the key", async () => {
    expect(await anchorSetup({})).toEqual({ status: "not-configured" });
    const cfg = JSON.stringify({ chainId: 11155111, address: "0x7020EE914B517Da8F7F8D42Dc436763898FaA8Ad", logId: LOG_ID });
    expect(await anchorSetup({ DEMO_PEP_ANCHOR: cfg })).toEqual({ status: "misconfigured", code: "anchor_key_missing" });
    for (const bad of ["59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x1234", `${publisherKey} `, "0x" + "0".repeat(64),
      "0x" + "f".repeat(64)])
      expect(await anchorSetup({ DEMO_PEP_ANCHOR: cfg, DEMO_PEP_ANCHOR_KEY: bad })).toEqual({ status: "misconfigured", code: "anchor_key_invalid" });
    expect((await anchorSetup({ DEMO_PEP_ANCHOR: cfg, DEMO_PEP_ANCHOR_KEY: publisherKey })).status).toBe("ready");
    // Mainnet is refused; another log id is refused; extra fields are refused.
    expect(await anchorSetup({ DEMO_PEP_ANCHOR: JSON.stringify({ ...JSON.parse(cfg), chainId: 1 }), DEMO_PEP_ANCHOR_KEY: publisherKey }))
      .toEqual({ status: "misconfigured", code: "anchor_chain_not_writable" });
    expect(await anchorSetup({ DEMO_PEP_ANCHOR: JSON.stringify({ ...JSON.parse(cfg), logId: "0x" + "1".repeat(64) }), DEMO_PEP_ANCHOR_KEY: publisherKey }))
      .toEqual({ status: "misconfigured", code: "anchor_log_mismatch" });
    expect((await anchorSetup({ DEMO_PEP_ANCHOR: JSON.stringify({ ...JSON.parse(cfg), extra: 1 }), DEMO_PEP_ANCHOR_KEY: publisherKey })).status)
      .toBe("misconfigured");
    // Discovery shows where epochs are anchored, never the key.
    const h = createDemoPep();
    const env = { ...baseEnv, DEMO_PEP_ANCHOR: cfg, DEMO_PEP_ANCHOR_KEY: publisherKey };
    const text = await (await h(new Request("https://attest.gmac.io/api/demo-pep"), env, new MemoryStore())).text();
    expect(JSON.parse(text).ledger.anchor).toMatchObject({ status: "configured", chainId: 11155111, logId: LOG_ID });
    expect(text).not.toContain(publisherKey.slice(2));
  });
  it("with anchoring not configured, publishing is a no-op and receipts stay sealed locally", async () => {
    const { handle } = pep();
    const store = new MemoryStore();
    const { ids, receipt } = await decisions(handle, baseEnv, store, 1);
    await handle.maintain(store);
    expect(await handle.publish(store, baseEnv)).toEqual({ status: "not-configured" });
    const r = await receipt(ids[0]!);
    expect(r.ledger.anchor.status).toBe("not-configured");
    expect(await verifyAgainstChain(r.receipt, r.ledger, ids[0]!, chainReader(), trust)).toEqual({ status: "not-configured" });
  });
});

// Negative cases run first, while the log has no epochs on-chain yet.
describe.skipIf(!anvilAvailable)("demo PEP epochs on DecisionLogAnchor (anvil, chain 11155111)", () => {
  it("an unauthorized publisher leaves the epoch unanchored, records the error and backs off", async () => {
    const { handle, writes } = pep();
    const store = new MemoryStore();
    const env = { ...baseEnv, DEMO_PEP_ANCHOR: anchorVar(), DEMO_PEP_ANCHOR_KEY: strangerKey };
    const { ids, receipt } = await decisions(handle, env, store, 1);
    await handle.maintain(store);
    const report = await handle.publish(store, env);
    expect(report).toMatchObject({ status: "failed", code: "contract_reverted:not_publisher", epoch: 1 });
    const row = (await store.get<EpochRow>("ledger:epoch:1"))!;
    expect(row.anchor).toBeUndefined();
    expect(row.anchorError).toMatchObject({ code: "contract_reverted:not_publisher" });
    const state = (await store.get<AnchorState>("anchor:state"))!;
    expect(state).toMatchObject({ next: 1, failures: 1 });
    expect(state.nextAttemptAt).toBeGreaterThan(Date.now() + 30_000);
    // The simulation reverted: no transaction was sent. Backing off: no further attempt until the retry time.
    expect(await reader.getTransactionCount({ address: accounts[2]! })).toBe(0);
    expect(await handle.publish(store, env)).toEqual({ status: "backing-off", anchored: [] });
    expect(writes()).toBe(1);
    // The receipt is still served, honestly awaiting anchoring, with the sanitized error.
    const r = await receipt(ids[0]!);
    expect(r.ledger.anchor).toMatchObject({ status: "awaiting-anchoring", lastError: { code: "contract_reverted:not_publisher" } });
    expect(JSON.stringify(r)).not.toContain(strangerKey.slice(2));
  });

  it("refuses a chain mismatch before sending anything", async () => {
    const { handle, writes } = pep((c) => ({ ...c, getChainId: async () => 31337 }));
    const store = new MemoryStore();
    const env = { ...baseEnv, DEMO_PEP_ANCHOR: anchorVar(), DEMO_PEP_ANCHOR_KEY: publisherKey };
    await decisions(handle, env, store, 1);
    await handle.maintain(store);
    expect(await handle.publish(store, env)).toMatchObject({ status: "failed", code: "chain_mismatch" });
    expect(writes()).toBe(0);
    expect((await store.get<EpochRow>("ledger:epoch:1"))!.anchor).toBeUndefined();
  });
  it("anchors sealed epochs from the alarm and the receipt verifies against the on-chain root", async () => {
    const { handle, writes } = pep();
    const store = new MemoryStore();
    const env = { ...baseEnv, DEMO_PEP_ANCHOR: anchorVar(), DEMO_PEP_ANCHOR_KEY: publisherKey };
    const first = await decisions(handle, env, store, 3);
    // Before sealing and publishing: awaiting anchoring.
    const pending = await first.receipt(first.ids[1]!);
    expect(pending.ledger.anchor.status).toBe("awaiting-anchoring");
    expect(await verifyAgainstChain(pending.receipt, pending.ledger, first.ids[1]!, chainReader(), trust)).toEqual({ status: "awaiting-anchoring" });
    // The on-demand seal asked for an early alarm.
    expect(store.alarm).toBeLessThan(Date.now() + 5_000);

    // The alarm: maintenance, then publication outside the queue. Two concurrent runs send one transaction.
    await handle.maintain(store);
    const [a, b] = await Promise.all([handle.publish(store, env), handle.publish(store, env)]);
    expect(a).toEqual({ status: "anchored", anchored: [1], more: false });
    expect(b).toBe(a);
    expect(writes()).toBe(1);
    const row = (await store.get<EpochRow & { anchor: { txHash: Hex; blockNumber: number } }>("ledger:epoch:1"))!;
    expect(row.anchor).toMatchObject({ chainId: 11155111, address, logId: LOG_ID, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    const tx = await reader.getTransaction({ hash: row.anchor.txHash });
    expect(tx.maxFeePerGas).toBe(MAX_FEE_PER_GAS);
    expect(Number(tx.blockNumber)).toBe(row.anchor.blockNumber);

    const r = await first.receipt(first.ids[1]!);
    expect(r.ledger.anchor.status).toBe("anchored");
    const check = await verifyAgainstChain(r.receipt, r.ledger, first.ids[1]!, chainReader(), trust);
    expect(check).toMatchObject({ status: "anchored", check: { ok: true }, txHash: row.anchor.txHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${row.anchor.txHash}` });
    expect(receiptVerdict(await verifyReceipt(r.receipt, first.ids[1]!), check)).toBe("anchored");

    // A tampered receipt fails against the on-chain root.
    const forged = { ...r.receipt, epoch: { ...r.receipt.epoch, root: "f".repeat(64) } };
    const bad = await verifyAgainstChain(forged, r.ledger, first.ids[1]!, chainReader(), trust);
    expect(bad).toMatchObject({ status: "anchored", check: { ok: false } });
    expect(() => receiptVerdict({ local: { ok: true }, inclusion: true, matchesDecision: true }, bad)).toThrow("receipt_anchor_mismatch");
    const edited = { ...r.receipt, decision: { ...r.receipt.decision, outcome: "allow" } };
    expect(await verifyAgainstChain(edited, r.ledger, first.ids[1]!, chainReader(), trust)).toMatchObject({ check: { ok: false, reason: "commitment_mismatch" } });
    // A PEP pointing the receipt at another contract is not trusted.
    const elsewhere = { ...r.receipt, epoch: { ...r.receipt.epoch, anchor: { ...(r.receipt.epoch.anchor as object), address: accounts[5] } } };
    expect((await verifyAgainstChain(elsewhere, r.ledger, first.ids[1]!, chainReader(), trust)).status).toBe("untrusted-anchor");

    // The next epoch continues the chain on-chain.
    const second = await decisions(handle, env, store, 2);
    await handle.maintain(store);
    expect(await handle.publish(store, env)).toEqual({ status: "anchored", anchored: [2], more: false });
    const r2 = await second.receipt(second.ids[0]!);
    expect(await verifyAgainstChain(r2.receipt, r2.ledger, second.ids[0]!, chainReader(), trust)).toMatchObject({ status: "anchored", check: { ok: true } });
    expect(await handle.publish(store, env)).toEqual({ status: "idle", anchored: [], more: false });

    // Idempotent retry: state lost after the transaction, the epoch is recognised as already anchored.
    await store.put("anchor:state", { next: 2, failures: 0, nextAttemptAt: 0, lastError: null } satisfies AnchorState);
    const before = writes();
    expect(await handle.publish(store, env)).toEqual({ status: "anchored", anchored: [2], more: false });
    expect(writes()).toBe(before);
  });
});
