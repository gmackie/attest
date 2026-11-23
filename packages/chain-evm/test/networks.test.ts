import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAddress } from "viem";
import { networks } from "../src/connected";
import {
  explorerTxUrl, networkByChainId, networkConfig, networkConfigs, networkIds, sepoliaOnlyContracts,
} from "../src/networks";

const root = path.resolve(import.meta.dirname, "../../..");
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

describe("network configuration", () => {
  it("describes Sepolia, Base Sepolia and mainnet with matching viem chains", () => {
    expect(networkIds.map((id) => [id, networkConfigs[id].chainId])).toEqual([["sepolia", 11155111], ["base-sepolia", 84532], ["mainnet", 1]]);
    for (const id of networkIds) {
      const n = networkConfigs[id];
      expect(n.chain.id).toBe(n.chainId);
      expect(networkByChainId(n.chainId)).toBe(n);
      // Two independent default providers, keyless https URLs, distinct operator labels.
      expect(n.rpcUrls).toHaveLength(2);
      expect(new Set(n.rpcUrls.map((r) => r.name)).size).toBe(2);
      expect(new Set(n.rpcUrls.map((r) => new URL(r.url).hostname.split(".").slice(-2).join("."))).size).toBe(2);
      for (const r of n.rpcUrls) expect(r.url).toMatch(/^https:\/\/[^/@?]+\/?$/);
      expect(n.finality).toEqual({ kind: "finalized" });
      expect(n.explorer.url).toMatch(/^https:\/\//);
      for (const instances of Object.values(n.contracts as Record<string, Record<string, string>>)) for (const a of Object.values(instances ?? {})) expect(isAddress(a)).toBe(true);
    }
    expect(networkConfigs["base-sepolia"].layer).toBe("op-stack-l2");
    expect(explorerTxUrl("base-sepolia", "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  it("keeps the legacy networks export and aliases working", () => {
    expect(networks.testnet).toBe(networkConfigs.sepolia.chain);
    expect(networks.production).toBe(networkConfigs.mainnet.chain);
    expect(networkConfig("testnet")).toBe(networkConfigs.sepolia);
    expect(networkConfig("production")).toBe(networkConfigs.mainnet);
    expect(() => networkConfig("base" as never)).toThrow("unknown_network");
  });

  it("mirrors the checked-in Sepolia deployment manifests", () => {
    const demo = json("apps/web/public/demo-deployment.json");
    const industry = json("apps/web/public/industry-deployments.json");
    const sepolia = networkConfigs.sepolia;
    expect(demo.chainId).toBe(sepolia.chainId);
    expect(industry.chainId).toBe(sepolia.chainId);
    expect(sepolia.contracts.InstitutionRegistry).toEqual({ [demo.profile]: demo.registry });
    expect(sepolia.contracts.IndustryRegistry).toEqual(industry.registries);
  });

  it("lists exactly the contracts whose constructors are locked to Sepolia", () => {
    const locked = ["DemoJourneyRegistry", "InstitutionRegistry", "IndustryRegistry", "AttestEconomy", "AttestZkMinter"]
      .filter((f) => /block\.chainid\s*!=\s*11155111/.test(readFileSync(path.join(root, `contracts/src/${f}.sol`), "utf8")));
    expect(locked).toHaveLength(5);
    for (const free of ["WorkspaceRegistry", "DecisionLogAnchor"]) {
      expect(readFileSync(path.join(root, `contracts/src/${free}.sol`), "utf8")).not.toMatch(/chainid\s*!=/);
      expect(sepoliaOnlyContracts).not.toContain(free);
    }
    expect(networkConfigs["base-sepolia"].unsupportedContracts).toEqual(sepoliaOnlyContracts);
    expect(Object.keys(networkConfigs["base-sepolia"].contracts).sort()).toEqual(["DecisionLogAnchor", "RevocationRoots", "StatusRegistry", "WorkspaceRegistryV2"]);
  });
});
