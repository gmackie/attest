import { readFileSync } from "node:fs";
import path from "node:path";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { networkConfigs, parseDeploymentManifest } from "../src/index";

const root = path.resolve(import.meta.dirname, "../../..");
const load = (chainId: number) => parseDeploymentManifest(
  JSON.parse(readFileSync(path.join(root, `contracts/deployments/${chainId}.json`), "utf8")),
);

describe.each([
  { network: "sepolia", chainId: 11155111 },
  { network: "base-sepolia", chainId: 84532 },
] as const)("pinned $network trust-stack manifest", ({ network, chainId }) => {
  const manifest = load(chainId);
  it("is for its chain and agrees with the network config", () => {
    expect(manifest.chainId).toBe(chainId);
    const contracts = networkConfigs[network].contracts as Record<string, Record<string, string>>;
    for (const d of manifest.deployments) expect(contracts[d.contract]?.default).toBe(d.address);
  });

  it("pins the runtime code compiled from the checked-in sources", () => {
    for (const d of manifest.deployments) {
      const artifact = JSON.parse(readFileSync(path.join(root, `contracts/artifacts/${d.contract}.json`), "utf8"));
      expect(keccak256(artifact.deployedBytecode), d.contract).toBe(d.runtimeCodeHash);
    }
  });
});
