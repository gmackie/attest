/** Shared helpers for anvil suites that run once per configured testnet chain ID (ATTE-26). */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { networkConfigs } from "../src/networks";

export const anvilBinary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
export const anvilAvailable = existsSync(anvilBinary);
/** Each suite runs against an anvil started with the network's chain ID; offset keeps ports apart. */
export const anvilNetworks = [
  { network: networkConfigs.sepolia, offset: 0 },
  { network: networkConfigs["base-sepolia"], offset: 1000 },
] as const;
