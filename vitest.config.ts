import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    coverage: { reporter: ["text", "json", "html"] },
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@pcd/pod"]
        }
      }
    }
  }
});
