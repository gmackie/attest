// Runs only scripts/live-journey.ts (kept out of the default suite): it spends sponsored Sepolia gas.
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// viem and @attest/* are not root dependencies; resolve the exact copy @attest/chain-evm uses (ESM entry points).
const viemRoot = path.resolve(import.meta.dirname, "../packages/chain-evm/node_modules/viem");
const viemExports = JSON.parse(readFileSync(path.join(viemRoot, "package.json"), "utf8")).exports;
const viem = (subpath: string) => path.join(viemRoot, viemExports[subpath].import);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^viem$/, replacement: viem(".") },
      { find: /^viem\/accounts$/, replacement: viem("./accounts") },
      { find: /^viem\/chains$/, replacement: viem("./chains") },
      // Workspace packages export their TypeScript sources.
      { find: /^@attest\/([a-z-]+)$/, replacement: path.resolve(import.meta.dirname, "../packages/$1/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["scripts/live-journey.ts"],
    testTimeout: 30 * 60000,
    deps: { optimizer: { ssr: { enabled: true, include: ["@pcd/pod"] } } },
  },
});
