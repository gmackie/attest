/**
 * Mainnet write gate (GMA-748, ATTE-26): every write entry point in @attest/chain-evm refuses
 * Ethereum mainnet without sending, signing or deploying anything. Runs in the normal `pnpm test`.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Address, EIP1193Provider, Hex } from "viem";
import { assertContext, deployRegistry, submitRegistryAction, type RegistryAction } from "../src/connected";
import { journeyDeploy, journeyWrite, type JourneyArtifact } from "../src/journey";
import { deployInstitutions } from "../src/institution";
import { deployIndustryRegistry } from "../src/industry";
import { hostOperation, sendHostOperation, type HostProfile } from "../src/host-setup";
import { signConversionVoucher, submitNativeZkConversion, submitSignedConversion, type ConversionVoucher } from "../src/economy";
import { decisionLogAnchorAdapter, viemAnchorClients, type AnchorPublisherClients } from "../src/decision-log";
import { assertWritable, localDevChainIds, networkConfigs, networkIds } from "../src/networks";
import { deployNetwork, maskedCodeHash } from "../scripts/deploy-network.mjs";
import { readFileSync } from "node:fs";

const account = "0x1111111111111111111111111111111111111111" as Address;
const target = "0x2222222222222222222222222222222222222222" as Address;
const h = (d: string) => `0x${d.repeat(64)}` as Hex;
const artifact: JourneyArtifact = { bytecode: "0x6000", deployedBytecode: "0x6000" };
const signing = new Set(["eth_sendTransaction", "eth_sendRawTransaction", "eth_signTransaction", "eth_signTypedData_v4", "personal_sign", "eth_sign"]);

/** A wallet connected to Ethereum mainnet that records every request. */
function mainnetWallet() {
  const calls: string[] = [];
  const provider = {
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as EIP1193Provider;
  return { provider, calls, signed: () => calls.filter((m) => signing.has(m)) };
}
/** A provider that must never be touched: the gate has to run first. */
function untouchable() {
  const calls: string[] = [];
  const provider = {
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      throw new Error("The mainnet gate must run before provider access");
    },
  } as unknown as EIP1193Provider;
  return { provider, calls };
}

describe("assertWritable", () => {
  it("allows the configured testnets and local development chains only", () => {
    for (const ref of ["sepolia", "base-sepolia", "testnet", 11155111, 84532, networkConfigs["base-sepolia"]] as const)
      expect(() => assertWritable(ref)).not.toThrow();
    for (const id of localDevChainIds) expect(() => assertWritable(id)).not.toThrow();
  });
  it("refuses Ethereum mainnet however it is named", () => {
    for (const ref of ["mainnet", "production", 1, networkConfigs.mainnet] as const)
      expect(() => assertWritable(ref)).toThrow(/production_writes_disabled: Production writes are disabled/);
  });
  it("fails closed on unknown networks and forged configs", () => {
    expect(() => assertWritable(8453)).toThrow("network_not_writable");
    expect(() => assertWritable(0)).toThrow("network_not_writable");
    expect(() => assertWritable("base" as never)).toThrow("unknown_network");
    // A config object cannot re-label mainnet as writable.
    expect(() => assertWritable({ ...networkConfigs.mainnet, writable: true } as never)).toThrow("production_writes_disabled");
    expect(() => assertWritable({ ...networkConfigs.sepolia, chainId: 1 } as never)).toThrow("unknown_network");
  });
  it("keeps exactly one non-writable configured network: mainnet", () => {
    expect(networkIds.filter((id) => !networkConfigs[id].writable)).toEqual(["mainnet"]);
  });
});

describe("every write entry point refuses mainnet", () => {
  it("registry actions and deployment, by legacy and new network names, before provider access", async () => {
    for (const network of ["production", "mainnet"] as const) {
      const { provider, calls } = untouchable();
      const functions: RegistryAction["functionName"][] = ["configureIssuer", "configureVerifier", "anchor", "revoke", "recordDecision"];
      for (const functionName of functions)
        await expect(submitRegistryAction(provider, network, account, target, { functionName, args: [] }))
          .rejects.toThrow("Production writes are disabled");
      await expect(deployRegistry(provider, network, account, "0x6000")).rejects.toThrow("Production writes are disabled");
      await expect(assertContext(provider, network, account, true)).rejects.toThrow("Production writes are disabled");
      expect(calls).toEqual([]);
    }
  });

  const sepoliaOnly: [string, (p: EIP1193Provider) => Promise<unknown>][] = [
    ["journeyWrite", (p) => journeyWrite(p, account, target, artifact, "grant", [])],
    ["journeyDeploy", (p) => journeyDeploy(p, account, artifact)],
    ["deployInstitutions", (p) => deployInstitutions(p, account, artifact, [account, account, account, account], [h("1"), h("2"), h("3")], 0n)],
    ["deployIndustryRegistry", (p) => deployIndustryRegistry(p, account, artifact, h("a"),
      [account, account, account, account, account, account], [h("1"), h("2"), h("3"), h("4"), h("5")], 0n)],
    ["sendHostOperation", (p) => {
      const spec = { id: "contractor", wallets: [account, account, account, account], keys: [h("1"), h("2"), h("3")], artifact } as HostProfile;
      return sendHostOperation(p, account, hostOperation(spec, 1n));
    }],
    ["submitSignedConversion", (p) => submitSignedConversion(p, account, target, { recipient: account } as ConversionVoucher, `0x${"1".repeat(130)}`)],
    ["submitNativeZkConversion", (p) => submitNativeZkConversion(p, account, target, {} as never)],
  ];
  it.each(sepoliaOnly)("%s refuses a wallet on chain 1 without sending or signing", async (_, call) => {
    const wallet = mainnetWallet();
    await expect(call(wallet.provider)).rejects.toThrow("Switch your wallet to Sepolia");
    expect(wallet.signed()).toEqual([]);
    expect(wallet.calls.every((m) => m === "eth_chainId" || m === "eth_accounts")).toBe(true);
  });

  it("signConversionVoucher refuses to sign for chain 1", async () => {
    await expect(signConversionVoucher(h("1"), target, { recipient: account } as ConversionVoucher, 1)).rejects.toThrow("restricted to Sepolia");
  });

  it("decisionLogAnchorAdapter refuses chain 1 and unknown chains at construction", () => {
    const touched: string[] = [];
    const clients = (chainId: number): AnchorPublisherClients => ({
      chainId,
      getChainId: async () => { touched.push("chainId"); return chainId; },
      readLatest: async () => { touched.push("read"); return 0n; },
      simulateAndWrite: async () => { touched.push("write"); return h("0"); },
      waitForReceipt: async () => { touched.push("wait"); return { status: "success", blockNumber: 1n }; },
    });
    expect(() => decisionLogAnchorAdapter({ clients: clients(1), address: target, log: h("1") })).toThrow("production_writes_disabled");
    expect(() => decisionLogAnchorAdapter({ clients: clients(8453), address: target, log: h("1") })).toThrow("network_not_writable");
    expect(() => decisionLogAnchorAdapter({ clients: clients(84532), address: target, log: h("1") })).not.toThrow();
    expect(touched).toEqual([]);
  });

  it("decisionLogAnchorAdapter gates on the chain the RPC reports, not the declared one", async () => {
    const epoch = { epoch: 1, root: "a".repeat(64), firstSeq: 1, lastSeq: 1, size: 1, firstPrevHash: "0".repeat(64), lastLeafHash: "b".repeat(64) };
    const run = async (declared: number | undefined, actual: number) => {
      const touched: string[] = [];
      const clients: AnchorPublisherClients = {
        ...(declared === undefined ? {} : { chainId: declared }),
        getChainId: async () => actual,
        readLatest: async () => { touched.push("read"); return 0n; },
        simulateAndWrite: async () => { touched.push("write"); return h("c"); },
        waitForReceipt: async () => ({ status: "success", blockNumber: 7n }),
      };
      const result = await decisionLogAnchorAdapter({ clients, address: target, log: h("1") }).anchor(epoch)
        .then((r) => r.ref, (e: { code?: string }) => e.code);
      return { result, touched };
    };
    // A testnet label on a mainnet RPC: refused before any read or write.
    expect(await run(11155111, 1)).toEqual({ result: "chain_mismatch", touched: [] });
    expect(await run(undefined, 1)).toEqual({ result: "production_writes_disabled", touched: [] });
    expect(await run(undefined, 8453)).toEqual({ result: "network_not_writable", touched: [] });
    expect(await run(84532, 11155111)).toEqual({ result: "chain_mismatch", touched: [] });
    // The receipt reference is built from the RPC-reported chain.
    const ok = await run(undefined, 84532);
    expect(ok.result).toMatch(/^eip155:84532:/);
    expect(ok.touched).toEqual(["read", "write"]);
  });

  it("viemAnchorClients refuses a wallet on a different chain than the reader", async () => {
    const reader = { getChainId: async () => 84532 } as never;
    const clients = viemAnchorClients(reader, { writeContract: async () => h("c"), getChainId: async () => 1 }, account);
    await expect(clients.getChainId()).rejects.toThrow("chain_mismatch");
    expect(clients.chainId).toBeUndefined();
    expect(await viemAnchorClients(reader, { writeContract: async () => h("c") }, account, 84532).getChainId()).toBe(84532);
  });

  it("deployNetwork refuses mainnet before touching the signer", async () => {
    for (const network of ["mainnet", "production"]) {
      const { provider, calls } = untouchable();
      await expect(deployNetwork({ network, provider })).rejects.toThrow("production_writes_disabled");
      await expect(deployNetwork({ network, privateKey: h("1") })).rejects.toThrow("production_writes_disabled");
      expect(calls).toEqual([]);
    }
    await expect(deployNetwork({ network: "base" })).rejects.toThrow("unknown_network");
  });

  it("the deploy CLI exits non-zero for mainnet without reading the key", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const run = spawnSync(path.join(root, "node_modules/.bin/tsx"), ["packages/chain-evm/scripts/deploy-network.mjs", "--network", "mainnet"], {
      cwd: root, encoding: "utf8", env: { ...process.env, ATTEST_DEPLOYER_PRIVATE_KEY: h("1") },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("production_writes_disabled");
    expect(run.stderr).not.toContain("1".repeat(64));
  }, 30_000);
});

describe("deploy-network runtime code verification", () => {
  it("masks only immutable slots: the WorkspaceRegistry administrator may differ, any other byte may not", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const a = JSON.parse(readFileSync(path.join(root, "contracts/artifacts/WorkspaceRegistry.json"), "utf8"));
    const refs = a.immutableReferences as Record<string, { start: number; length: number }[]>;
    const slots = Object.values(refs).flat();
    expect(slots.length).toBeGreaterThan(0);
    const patch = (at: number, hex: string) => {
      const code = a.deployedBytecode.slice(2);
      return `0x${code.slice(0, at * 2)}${hex}${code.slice(at * 2 + hex.length)}` as Hex;
    };
    const expected = maskedCodeHash(a.deployedBytecode, refs);
    const admin = "1111111111111111111111111111111111111111".padStart(64, "0");
    expect(maskedCodeHash(patch(slots[0]!.start, admin), refs)).toBe(expected);
    expect(maskedCodeHash(patch(0, "ff"), refs)).not.toBe(expected);
    expect(() => maskedCodeHash("0x00", refs)).toThrow("outside the code");
  });
});
