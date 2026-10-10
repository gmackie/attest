import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Proof generation is CPU-heavy; avoid oversubscribing CI and use its real budget.
    maxWorkers: 1,
    testTimeout: 120000,
    include: ["packages/*/test/**/*.test.ts"],
    coverage: { reporter: ["text", "json", "html"] },
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@pcd/pod"],
        },
      },
    },
  },
});
