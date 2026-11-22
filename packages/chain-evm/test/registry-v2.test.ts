import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import {
  BaseError, ContractFunctionRevertedError, getAddress, createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { registryAbi } from "../src/connected";
import {
  DEPLOYMENT_MANIFEST_SCHEMA, codeReadingEndpoint, loadDeploymentManifest, parseDeploymentManifest, pinnedDeployment,
  sourceDigest, verifyPinnedDeployment, type DeploymentManifest,
} from "../src/manifest";
import {
  deployRegistryV2, encodeRegistryV2Call, reasonCode, reasonLabel, registryV2Abi, registryV2AnchorKey, registryV2AnchorStatus,
  registryV2KeyValidity, registryV2Writer, type RegistryV2AnchorQuery, type RegistryV2Write,
} from "../src/registry-v2";
import { createChainStatusReader, publicClientEndpoint, readRegistryVersion, workspaceAnchorStatus } from "../src/status";

const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const available = existsSync(binary);
const root = path.resolve(import.meta.dirname, "../../..");
const port = 18905, url = `http://127.0.0.1:${port}`;
const reader = createPublicClient({ chain: sepolia, transport: http(url) });
const wallet = createWalletClient({ chain: sepolia, transport: http(url) });
const hex = (digit: string) => `0x${digit.repeat(64)}` as Hex;
let anvil: ChildProcess | undefined, accounts: Address[] = [];
let registry: Address, manifest: DeploymentManifest, safe: Address, v1: Address;

/** A minimal 2-of-3 multisig standing in for a Safe: the registry only ever sees the contract as msg.sender. */
const SAFE_LIKE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
contract SafeLike {
  address[3] public owners; uint256 public nonce;
  mapping(bytes32 => mapping(address => bool)) public approved;
  mapping(bytes32 => uint256) public approvals;
  constructor(address[3] memory owners_) { owners = owners_; }
  function isOwner(address a) internal view returns (bool) { return a == owners[0] || a == owners[1] || a == owners[2]; }
  function execute(address target, bytes calldata data) external returns (bool executed) {
    require(isOwner(msg.sender), "not owner");
    bytes32 id = keccak256(abi.encode(target, data, nonce));
    require(!approved[id][msg.sender], "duplicate");
    approved[id][msg.sender] = true;
    if (++approvals[id] < 2) return false;
    nonce++;
    (bool ok, bytes memory ret) = target.call(data);
    if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    return true;
  }
}`;
const safeAbi = parseAbi(["function execute(address target,bytes data) returns (bool)", "function nonce() view returns (uint256)"]);

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const advance = async (seconds: number) => { await rpc("evm_increaseTime", [seconds]); await rpc("anvil_mine", ["0x1"]); };
const now = async () => (await reader.getBlock({ blockTag: "latest" })).timestamp;

const writer = (account: Address, chainId = 11155111) =>
  registryV2Writer({ publicClient: reader, walletClient: wallet, account, chainId }, registry);
const send = (account: Address, fn: RegistryV2Write, args: readonly unknown[] = []) => writer(account).write(fn, args);
/** Custom error name a call would revert with, or "ok". */
async function revert(account: Address, fn: string, args: readonly unknown[] = [], address = registry, abi: readonly unknown[] = registryV2Abi) {
  try {
    await reader.simulateContract({ address, abi: abi as typeof registryV2Abi, account, functionName: fn as never, args: args as never });
    return "ok";
  } catch (e) {
    const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    return r instanceof ContractFunctionRevertedError ? (r.data?.errorName ?? r.reason ?? "reverted") : String(e).slice(0, 200);
  }
}
/** One Safe owner's approval; the call executes on the second distinct owner. */
async function safeApprove(owner: Address, fn: RegistryV2Write, args: readonly unknown[] = []) {
  const sim = await reader.simulateContract({ address: safe, abi: safeAbi, account: owner, functionName: "execute",
    args: [registry, encodeRegistryV2Call(fn, args)] });
  await reader.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
  return sim.result;
}
const viaSafe = async (fn: RegistryV2Write, args: readonly unknown[] = []) => {
  expect(await safeApprove(accounts[5]!, fn, args)).toBe(false);
  expect(await safeApprove(accounts[6]!, fn, args)).toBe(true);
};
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

const statusReader = (chainId = 11155111) => createChainStatusReader({
  chainId,
  endpoints: [codeReadingEndpoint("primary", createPublicClient({ chain: sepolia, transport: http(url) })),
    codeReadingEndpoint("secondary", createPublicClient({ chain: sepolia, transport: http(url) }))],
  finality: { kind: "confirmations", confirmations: 1 }, maxBlockAgeMs: 3_600_000_000, now: () => Date.now(),
});

beforeAll(async () => {
  if (!available) return;
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], { cwd: path.join(root, "contracts"), encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  anvil = spawn(binary, ["--port", String(port), "--chain-id", "11155111", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100 && accounts.length === 0; i++) {
    try { accounts = await wallet.getAddresses(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (accounts.length < 8) throw new Error("Anvil failed to start");

  const solc = createRequire(path.join(root, "contracts/package.json"))("solc");
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "SafeLike.sol": { content: SAFE_LIKE } },
    settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const safeArtifact = out.contracts["SafeLike.sol"].SafeLike;
  const safeTx = await wallet.deployContract({ account: accounts[0]!, abi: safeArtifact.abi, bytecode: `0x${safeArtifact.evm.bytecode.object}`,
    args: [[accounts[5]!, accounts[6]!, accounts[7]!]] });
  safe = getAddress((await reader.waitForTransactionReceipt({ hash: safeTx })).contractAddress!);

  // The initial administrator is an EOA (accounts[0]) whose key is "lost" in the first drill.
  const artifact = JSON.parse(readFileSync(path.join(root, "contracts/artifacts/WorkspaceRegistryV2.json"), "utf8"));
  const deployed = await deployRegistryV2({ publicClient: reader, walletClient: wallet, account: accounts[0]!, chainId: 11155111 },
    { bytecode: artifact.bytecode, administrator: accounts[0]! });
  registry = deployed.address;
  manifest = parseDeploymentManifest({
    schema: DEPLOYMENT_MANIFEST_SCHEMA, chainId: 11155111,
    deployments: [{ ...deployed, sourceDigest: sourceDigest(readFileSync(path.join(root, "contracts/src/WorkspaceRegistryV2.sol"), "utf8")),
      compiler: { solc: "0.8.x (contracts/node_modules/solc)", evmVersion: "paris", optimizer: { enabled: false } } }],
  });

  const v1Artifact = JSON.parse(readFileSync(path.join(root, "contracts/artifacts/WorkspaceRegistry.json"), "utf8"));
  const v1Tx = await wallet.deployContract({ account: accounts[0]!, abi: v1Artifact.abi, bytecode: v1Artifact.bytecode });
  v1 = (await reader.waitForTransactionReceipt({ hash: v1Tx })).contractAddress!;
}, 60_000);
afterAll(() => anvil?.kill());

describe.skipIf(!available)("WorkspaceRegistryV2", () => {
  const issuer = () => accounts[1]!;
  const scope = hex("a"), k1 = hex("1"), k2 = hex("2"), k3 = hex("3");
  const query = (anchorId: Hex, signingKeyHash = k1, extra: Partial<RegistryV2AnchorQuery> = {}): RegistryV2AnchorQuery =>
    ({ registry, anchorId, issuer: issuer(), scope, commitment: hex("c"), signingKeyHash, ...extra });
  const status = (q: RegistryV2AnchorQuery) => registryV2AnchorStatus(statusReader(), manifest, q);
  const anchor = async (id: Hex) => send(issuer(), "anchor", [id, scope, hex("c"), (await now()) + 30n * 86_400n]);
  const anchoredAt = async (id: Hex) =>
    ((await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "anchorBindings", args: [registryV2AnchorKey(issuer(), id)] })) as readonly [Hex, bigint])[1];

  describe("manifest verification", () => {
    it("accepts the pinned registry and refuses wrong code hash, wrong chain, wrong contract and missing manifests", async () => {
      const ok = await verifyPinnedDeployment(statusReader(), manifest, { contract: "WorkspaceRegistryV2", address: registry });
      expect(ok.record.runtimeCodeHash).toBe(manifest.deployments[0]!.runtimeCodeHash);
      expect(ok.evidence).toMatchObject({ source: "chain", chainId: 11155111 });

      const tampered = { ...manifest, deployments: [{ ...manifest.deployments[0]!, runtimeCodeHash: hex("e") }] };
      expect(await code(verifyPinnedDeployment(statusReader(), tampered, { contract: "WorkspaceRegistryV2", address: registry }))).toBe("codehash_mismatch");
      // A different contract (V1) at an address the manifest claims is V2.
      const substituted = { ...manifest, deployments: [{ ...manifest.deployments[0]!, address: v1 }] };
      expect(await code(verifyPinnedDeployment(statusReader(), substituted, { contract: "WorkspaceRegistryV2", address: v1 }))).toBe("codehash_mismatch");
      // An address with no code at all.
      const empty = { ...manifest, deployments: [{ ...manifest.deployments[0]!, address: accounts[9]! }] };
      expect(await code(verifyPinnedDeployment(statusReader(), empty, { contract: "WorkspaceRegistryV2", address: accounts[9]! }))).toBe("no_code");

      expect(await code(verifyPinnedDeployment(statusReader(), { ...manifest, chainId: 1 }, { contract: "WorkspaceRegistryV2", address: registry }))).toBe("manifest_chain_mismatch");
      // Reader configured for another chain than the RPCs serve: refused before any code is trusted.
      expect(await code(verifyPinnedDeployment(statusReader(1), { ...manifest, chainId: 1 }, { contract: "WorkspaceRegistryV2", address: registry }))).toBe("chain_mismatch");
      expect(await code(verifyPinnedDeployment(statusReader(), null, { contract: "WorkspaceRegistryV2", address: registry }))).toBe("manifest_missing");
      expect(await code(verifyPinnedDeployment(statusReader(), manifest, { contract: "WorkspaceRegistryV2", address: v1 }))).toBe("manifest_missing");
      expect(await code(verifyPinnedDeployment(statusReader(), manifest, { contract: "WorkspaceRegistry", address: registry }))).toBe("manifest_contract_mismatch");
      expect(await code(loadDeploymentManifest(11155111, async () => null))).toBe("manifest_missing");
      expect(await code(loadDeploymentManifest(11155111, async () => ({ ...manifest, chainId: 1 })))).toBe("manifest_chain_mismatch");
      expect((await loadDeploymentManifest(11155111, async (p) => (p === "contracts/deployments/11155111.json" ? manifest : null))).chainId).toBe(11155111);
    });

    it("rejects malformed manifests and refuses status reads from an unpinned or tampered registry", async () => {
      expect(() => parseDeploymentManifest({ ...manifest, schema: "v0" })).toThrow("manifest_invalid");
      expect(() => parseDeploymentManifest({ ...manifest, deployments: [{ ...manifest.deployments[0]!, runtimeCodeHash: "0x12" }] })).toThrow("manifest_invalid");
      // keccak256("0x"): pinning "no code" is refused.
      expect(() => parseDeploymentManifest({ ...manifest, deployments: [{ ...manifest.deployments[0]!,
        runtimeCodeHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" }] })).toThrow("manifest_invalid");
      expect(() => parseDeploymentManifest({ ...manifest, deployments: [manifest.deployments[0]!, manifest.deployments[0]!] })).toThrow("manifest_invalid");
      expect(() => pinnedDeployment(undefined, { chainId: 11155111, contract: "WorkspaceRegistryV2", address: registry })).toThrow("manifest_missing");
      const tampered = { ...manifest, deployments: [{ ...manifest.deployments[0]!, runtimeCodeHash: hex("e") }] };
      expect(await code(registryV2AnchorStatus(statusReader(), tampered, query(hex("9"))))).toBe("codehash_mismatch");
      expect(await code(registryV2AnchorStatus(statusReader(), null, query(hex("9"))))).toBe("manifest_missing");
      // Endpoints that cannot read code cannot satisfy a manifest check.
      const noCode = createChainStatusReader({ ...statusReader().options,
        endpoints: [publicClientEndpoint("a", reader), publicClientEndpoint("b", reader)] });
      expect(await code(registryV2AnchorStatus(noCode, manifest, query(hex("9"))))).toBe("code_read_unsupported");
    });
  });

  describe("lost-key drill: administrator rotation to a Safe-like contract", () => {
    it("a pending rotation completes from the contract after the old key is lost; the old admin cannot act", async () => {
      expect(await revert(accounts[2]!, "proposeAdministrator", [safe])).toBe("Unauthorized");
      await send(accounts[0]!, "proposeAdministrator", [safe]);
      expect(await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "pendingAdministrator" })).toBe(safe);
      // accounts[0]'s key is now treated as lost: nothing below is signed by it.
      expect(await revert(accounts[5]!, "acceptAdministrator")).toBe("NotPendingAdministrator");
      await viaSafe("acceptAdministrator");
      expect(await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "administrator" })).toBe(safe);
      expect(await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "pendingAdministrator" }))
        .toBe("0x0000000000000000000000000000000000000000");
      // The old administrator (were its key to resurface) has no authority.
      expect(await revert(accounts[0]!, "configureIssuer", [issuer(), scope, k1, true])).toBe("Unauthorized");
      expect(await revert(accounts[0]!, "proposeAdministrator", [accounts[0]!])).toBe("Unauthorized");
      expect(await revert(accounts[0]!, "emergencyRevokeGrant", [issuer(), scope, reasonCode("issuer_account_lost")])).toBe("Unauthorized");
      // A single Safe owner cannot act alone; two of three do.
      expect(await safeApprove(accounts[5]!, "configureIssuer", [issuer(), scope, k1, true])).toBe(false);
      expect((await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "issuers", args: [issuer(), scope] }))[0]).toBe(false);
      expect(await safeApprove(accounts[7]!, "configureIssuer", [issuer(), scope, k1, true])).toBe(true);
      expect((await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "issuers", args: [issuer(), scope] }))[0]).toBe(true);
    });

    it("a proposal that is not accepted can be cancelled or replaced", async () => {
      await viaSafe("proposeAdministrator", [accounts[3]!]);
      await viaSafe("proposeAdministrator", [accounts[4]!]);
      expect(await revert(accounts[3]!, "acceptAdministrator")).toBe("NotPendingAdministrator");
      await viaSafe("cancelAdministratorProposal");
      expect(await revert(accounts[4]!, "acceptAdministrator")).toBe("NotPendingAdministrator");
      expect(await revert(accounts[4]!, "cancelAdministratorProposal")).toBe("Unauthorized");
      expect(await revert(safe, "cancelAdministratorProposal")).toBe("InvalidInput");
      expect(await revert(safe, "proposeAdministrator", ["0x0000000000000000000000000000000000000000"])).toBe("InvalidInput");
      expect(await revert(safe, "proposeAdministrator", [safe])).toBe("InvalidInput");
      expect(await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "administrator" })).toBe(safe);
    });

    it("a proposal lapses after PROPOSAL_TTL and cannot be accepted; a fresh proposal can", async () => {
      const ttl = await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "PROPOSAL_TTL" });
      expect(ttl).toBe(7n * 86_400n);
      await viaSafe("proposeAdministrator", [accounts[3]!]);
      const proposedAt = await now();
      const deadline = await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "pendingAdministratorDeadline" });
      expect(deadline).toBe(proposedAt + ttl);
      expect(await revert(accounts[3]!, "acceptAdministrator")).toBe("ok");
      await rpc("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
      await rpc("anvil_mine", ["0x1"]);
      expect(await revert(accounts[3]!, "acceptAdministrator")).toBe("ProposalExpired");
      expect(await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "administrator" })).toBe(safe);
      // A lapsed proposal is replaced by a new one with a new deadline, then cancelled to restore state.
      await viaSafe("proposeAdministrator", [accounts[3]!]);
      expect(await revert(accounts[3]!, "acceptAdministrator")).toBe("ok");
      await viaSafe("cancelAdministratorProposal");
      expect(await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "pendingAdministratorDeadline" })).toBe(0n);
    });
  });

  describe("compromise drill", () => {
    it("anchors before the cutoff stay valid, at/after it are rejected, and a rotated key continues service", async () => {
      await anchor(hex("d"));
      await advance(600);
      await anchor(hex("e"));
      const cutoff = await anchoredAt(hex("e"));
      expect(await status(query(hex("e")))).toMatchObject({ status: "active", anchoredAt: Number(cutoff) * 1000 });

      // The issuer itself may report compromise of its key; unrelated accounts may not; cutoff cannot be in the future.
      expect(await revert(accounts[2]!, "markIssuerKeyCompromised", [issuer(), k1, cutoff, reasonCode("key_compromise")])).toBe("Unauthorized");
      expect(await revert(issuer(), "markIssuerKeyCompromised", [issuer(), k1, (await now()) + 3600n, reasonCode("key_compromise")])).toBe("InvalidInput");
      await send(issuer(), "markIssuerKeyCompromised", [issuer(), k1, cutoff, reasonCode("key_compromise")]);
      // The cutoff can only move earlier.
      expect(await revert(safe, "markIssuerKeyCompromised", [issuer(), k1, cutoff, reasonCode("key_compromise")])).toBe("AlreadyUsed");

      expect(await status(query(hex("d")))).toMatchObject({ status: "active" });
      const rejected = await status(query(hex("e")));
      expect(rejected).toMatchObject({ status: "revoked", reason: "key_compromised",
        compromise: { compromisedAt: Number(cutoff) * 1000, label: "key_compromise" } });
      // A credential claiming to be signed at or after the cutoff is rejected even if anchored before it.
      expect(await status(query(hex("d"), k1, { signedAt: Number(cutoff) * 1000 }))).toMatchObject({ reason: "key_compromised" });
      expect(await status(query(hex("d"), k1, { signedAt: Number(cutoff) * 1000 - 1 }))).toMatchObject({ status: "active" });
      // The compromised key can no longer anchor, and cannot be re-enabled.
      expect(await revert(issuer(), "anchor", [hex("f"), scope, hex("c"), (await now()) + 86_400n])).toBe("KeyUnusable");
      expect(await revert(safe, "configureIssuer", [issuer(), scope, k1, true])).toBe("KeyUnusable");

      // Rotation to a new key continues service; old pre-cutoff anchors are unaffected.
      expect(await revert(issuer(), "rotateIssuerKey", [issuer(), scope, k2])).toBe("Unauthorized");
      await viaSafe("rotateIssuerKey", [issuer(), scope, k2]);
      await anchor(hex("f"));
      expect(await status(query(hex("f"), k2))).toMatchObject({ status: "active", signingKeyHash: k2 });
      expect(await status(query(hex("d")))).toMatchObject({ status: "active", signingKeyHash: k1 });
      // Anchors are bound to the key they were written with: presenting another key fails closed.
      expect(await code(status(query(hex("f"), k1)))).toBe("anchor_mismatch");
      expect(await code(status(query(hex("d"), k2)))).toBe("anchor_mismatch");
      // Another issuer has its own namespace: the same id there is simply not anchored.
      expect(await status({ ...query(hex("f"), k2), issuer: accounts[2]! })).toBeNull();
      expect(await code(status({ ...query(hex("f"), k2), commitment: hex("6") }))).toBe("anchor_mismatch");
      expect(await status(query(hex("9")))).toBeNull();

      const validity = await registryV2KeyValidity(statusReader(), manifest,
        { registry, issuer: issuer(), signingKeyHash: k1, at: Number(cutoff) * 1000 });
      expect(validity).toMatchObject({ valid: false, reason: "key_compromised", compromisedAt: Number(cutoff) * 1000 });
      expect((await registryV2KeyValidity(statusReader(), manifest,
        { registry, issuer: issuer(), signingKeyHash: k1, at: Number(cutoff) * 1000 - 1000 })).valid).toBe(true);
    });

    it("enforces key validity windows: not yet valid, expired, and unknown keys", async () => {
      const start = (await now()) + 3600n;
      expect(await revert(safe, "registerIssuerKey", [issuer(), k3, (await now()) - 10n, start + 3600n])).toBe("InvalidInput");
      await viaSafe("registerIssuerKey", [issuer(), k3, start, start + 7200n]);
      expect(await revert(safe, "rotateIssuerKey", [issuer(), scope, k3])).toBe("KeyUnusable");
      const early = await registryV2KeyValidity(statusReader(), manifest, { registry, issuer: issuer(), signingKeyHash: k3, at: Number(await now()) * 1000 });
      expect(early).toMatchObject({ valid: false, reason: "key_not_yet_valid", validFrom: Number(start) * 1000, validUntil: Number(start + 7200n) * 1000 });
      expect((await registryV2KeyValidity(statusReader(), manifest, { registry, issuer: issuer(), signingKeyHash: hex("4"), at: 0 })).reason).toBe("key_unknown");

      await advance(3600);
      await viaSafe("rotateIssuerKey", [issuer(), scope, k3]);
      await anchor(hex("b"));
      expect(await status(query(hex("b"), k3))).toMatchObject({ status: "active" });
      // A credential claiming a signing time outside the key's window is rejected.
      expect(await status(query(hex("b"), k3, { signedAt: Number(start) * 1000 - 1000 }))).toMatchObject({ reason: "key_not_yet_valid" });
      expect(await status(query(hex("b"), k3, { signedAt: Number(start + 7200n) * 1000 }))).toMatchObject({ reason: "key_expired" });

      // Planned retirement: never retroactive; afterwards the key cannot anchor, earlier anchors stay valid.
      expect(await revert(safe, "retireIssuerKey", [issuer(), k3, (await now()) - 1n])).toBe("InvalidInput");
      await viaSafe("retireIssuerKey", [issuer(), k3, (await now()) + 60n]);
      await advance(120);
      expect(await revert(issuer(), "anchor", [hex("5"), scope, hex("c"), (await now()) + 86_400n])).toBe("KeyUnusable");
      expect(await status(query(hex("b"), k3))).toMatchObject({ status: "active" });
      expect((await registryV2KeyValidity(statusReader(), manifest, { registry, issuer: issuer(), signingKeyHash: k3, at: Number(await now()) * 1000 })).reason).toBe("key_expired");
      // Restore service on a fresh key for the next scenario.
      await viaSafe("rotateIssuerKey", [issuer(), scope, hex("5")]);
    });
  });

  describe("emergency revocation", () => {
    it("revokes an anchor with a reason visible to clients; only the admin can; it is irreversible", async () => {
      await anchor(hex("7"));
      const q = query(hex("7"), hex("5"));
      expect(await status(q)).toMatchObject({ status: "active" });
      const reason = reasonCode("issued_in_error");
      expect(await revert(issuer(), "emergencyRevokeAnchor", [issuer(), hex("7"), reason])).toBe("Unauthorized");
      expect(await revert(accounts[0]!, "emergencyRevokeAnchor", [issuer(), hex("7"), reason])).toBe("Unauthorized");
      expect(await revert(safe, "emergencyRevokeAnchor", [issuer(), hex("7"), hex("0")])).toBe("InvalidInput");
      expect(await revert(safe, "emergencyRevokeAnchor", [issuer(), hex("8"), reason])).toBe("InvalidInput");
      // The same id under another issuer's namespace does not exist.
      expect(await revert(safe, "emergencyRevokeAnchor", [accounts[2]!, hex("7"), reason])).toBe("InvalidInput");
      await viaSafe("emergencyRevokeAnchor", [issuer(), hex("7"), reason]);
      const revoked = await status(q);
      expect(revoked).toMatchObject({ status: "revoked", reason: "emergency_revoked",
        revocation: { target: "anchor", reason: reason.toLowerCase(), label: "issued_in_error" } });
      expect(reasonLabel(revoked!.revocation!.reason)).toBe("issued_in_error");
      // Irreversible: no undo function exists, a second revocation is refused, and the issuer's own revoke is a no-op.
      expect(await revert(safe, "emergencyRevokeAnchor", [issuer(), hex("7"), reasonCode("superseded")])).toBe("AlreadyUsed");
      expect(await revert(issuer(), "revoke", [hex("7")])).toBe("AlreadyUsed");
      expect(registryV2Abi.some((x) => x.type === "function" && /unrevoke|restore|reinstate/i.test(x.name))).toBe(false);
      // The V1-shaped getter, keyed by anchorKey(issuer, id), shows the revocation in its `revoked` flag.
      const v1View = await reader.readContract({ address: registry, abi: registryAbi, functionName: "anchors", args: [registryV2AnchorKey(issuer(), hex("7"))] });
      expect(v1View[4]).toBe(true);
    });

    it("revokes an issuer grant: all its anchors are invalid, no new anchors, and it can never be re-enabled", async () => {
      await anchor(hex("6"));
      const reason = reasonCode("issuer_account_lost");
      expect(await revert(issuer(), "emergencyRevokeGrant", [issuer(), scope, reason])).toBe("Unauthorized");
      await viaSafe("emergencyRevokeGrant", [issuer(), scope, reason]);
      for (const [id, key] of [[hex("6"), hex("5")], [hex("d"), k1], [hex("f"), k2]] as const)
        expect(await status(query(id, key))).toMatchObject({ status: "revoked", reason: "emergency_revoked",
          revocation: { target: "grant", label: "issuer_account_lost" } });
      expect(await revert(issuer(), "anchor", [hex("4"), scope, hex("c"), (await now()) + 86_400n])).toBe("Unauthorized");
      expect(await revert(safe, "configureIssuer", [issuer(), scope, hex("5"), true])).toBe("GrantRevoked");
      expect(await revert(safe, "rotateIssuerKey", [issuer(), scope, hex("6")])).toBe("InvalidInput");
      expect(await revert(safe, "emergencyRevokeGrant", [issuer(), scope, reason])).toBe("AlreadyUsed");
    });
  });

  describe("anchor namespacing", () => {
    it("ids are per issuer: another issuer cannot squat, revoke or shadow an id", async () => {
      const scope2 = hex("b"), other = accounts[2]!, id = hex("3");
      await viaSafe("configureIssuer", [issuer(), scope2, hex("8"), true]);
      await viaSafe("configureIssuer", [other, scope2, hex("7"), true]);
      const deadline = (await now()) + 86_400n;
      // `other` front-runs issuer()'s id with its own commitment; issuer() can still anchor it.
      await send(other, "anchor", [id, scope2, hex("6"), deadline]);
      await send(issuer(), "anchor", [id, scope2, hex("c"), deadline]);
      expect(await revert(issuer(), "anchor", [id, scope2, hex("c"), deadline])).toBe("AlreadyUsed");
      const mine = { registry, anchorId: id, issuer: issuer(), scope: scope2, commitment: hex("c"), signingKeyHash: hex("8") };
      const theirs = { registry, anchorId: id, issuer: other, scope: scope2, commitment: hex("6"), signingKeyHash: hex("7") };
      expect(await status(mine)).toMatchObject({ status: "active" });
      expect(await status(theirs)).toMatchObject({ status: "active" });
      // Revoking "the same id" only touches the caller's own anchor.
      await send(other, "revoke", [id]);
      expect(await status(theirs)).toMatchObject({ reason: "anchor_revoked" });
      expect(await status(mine)).toMatchObject({ status: "active" });
      // Presenting the other issuer's commitment under this issuer fails closed.
      expect(await code(status({ ...mine, commitment: hex("6") }))).toBe("anchor_mismatch");
      // Contract and client derive the same key; the V1-shaped getter is coherent with it.
      const key = registryV2AnchorKey(issuer(), id);
      expect(await reader.readContract({ address: registry, abi: registryV2Abi, functionName: "anchorKey", args: [issuer(), id] })).toBe(key);
      const view = await reader.readContract({ address: registry, abi: registryAbi, functionName: "anchors", args: [key] });
      expect(view[0]).toBe(issuer());
      expect(view[2]).toBe(hex("c"));
      expect((await reader.readContract({ address: registry, abi: registryAbi, functionName: "anchors", args: [id] }))[0])
        .toBe("0x0000000000000000000000000000000000000000");
    });
  });

  describe("V1 reader against V2", () => {
    it("V1 workspaceAnchorStatus refuses a V2 registry and still reads a V1 registry", async () => {
      const r = statusReader();
      const snap = await r.snapshot();
      expect(await r.read(snap, (c, n) => readRegistryVersion(c, registry, n))).toBe(2n);
      expect(await r.read(snap, (c, n) => readRegistryVersion(c, v1, n))).toBe(1n);
      // A compromised-key anchor (hex "e", see compromise drill) must not come back "active" from the V1 reader.
      const q = { registry, anchorId: hex("e"), issuer: issuer(), scope, commitment: hex("c"), signingKeyHash: k1 };
      expect(await code(workspaceAnchorStatus(r, q))).toBe("registry_requires_v2_reader");
      expect(await code(workspaceAnchorStatus(r, { ...q, anchorId: registryV2AnchorKey(issuer(), hex("e")) }))).toBe("registry_requires_v2_reader");
      expect(await code(workspaceAnchorStatus(r, { ...q, anchorId: hex("0") }))).toBe("registry_requires_v2_reader");

      // A real V1 registry is unaffected.
      const v1Write = async (account: Address, functionName: string, args: readonly unknown[]) => {
        const sim = await reader.simulateContract({ address: v1, abi: registryAbi, account, functionName: functionName as never, args: args as never });
        await reader.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
      };
      await v1Write(accounts[0]!, "configureIssuer", [issuer(), scope, k1, true]);
      await v1Write(issuer(), "anchor", [hex("e"), scope, hex("c"), (await now()) + 86_400n]);
      expect(await workspaceAnchorStatus(statusReader(), { ...q, registry: v1 })).toMatchObject({ status: "active" });
    });
  });

  describe("V1 ABI on V2", () => {
    it("keeps V1 write signatures, receipts and grant suspension semantics", async () => {
      const scope3 = hex("9");
      await viaSafe("configureIssuer", [issuer(), scope3, hex("8"), true]);
      const sim = await reader.simulateContract({ address: registry, abi: registryAbi, account: issuer(), functionName: "anchor",
        args: [hex("2"), scope3, hex("c"), (await now()) + 86_400n] });
      await reader.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
      const q = { registry, anchorId: hex("2"), issuer: issuer(), scope: scope3, commitment: hex("c"), signingKeyHash: hex("8") };
      expect(await status(q)).toMatchObject({ status: "active" });
      await viaSafe("configureIssuer", [issuer(), scope3, hex("8"), false]);
      expect(await status(q)).toMatchObject({ status: "revoked", reason: "issuer_grant_inactive" });
      await viaSafe("configureIssuer", [issuer(), scope3, hex("8"), true]);
      // Unlike V1, rotation keeps earlier anchors active.
      await viaSafe("rotateIssuerKey", [issuer(), scope3, hex("4")]);
      expect(await status(q)).toMatchObject({ status: "active" });
      await viaSafe("configureVerifier", [accounts[2]!, true]);
      await send(accounts[2]!, "recordDecision", [hex("1"), hex("2"), true]);
      expect(await revert(accounts[2]!, "recordDecision", [hex("1"), hex("2"), true])).toBe("AlreadyUsed");
      expect(await revert(accounts[3]!, "recordDecision", [hex("2"), hex("2"), true])).toBe("Unauthorized");
    });
  });

  describe("writes", () => {
    it("refuses chain ID 1 and a chain the RPC does not serve", async () => {
      expect(() => writer(accounts[0]!, 1)).toThrow("production_writes_disabled");
      expect(await code(writer(accounts[0]!, 17000).write("revoke", [hex("1")]))).toBe("chain_mismatch");
      expect(await code(deployRegistryV2({ publicClient: reader, walletClient: wallet, account: accounts[0]!, chainId: 1 },
        { bytecode: "0x00", administrator: safe }))).toBe("production_writes_disabled");
    });
  });
});
