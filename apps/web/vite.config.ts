import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      // GPC proving reaches snarkjs/fastfile, which imports a wider Node-core
      // surface than the app itself. Let the plugin provide its complete
      // browser-safe shim set instead of maintaining a brittle allowlist.
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true
    })
  ],
  build: {
    target: "es2022",
    sourcemap: true
  },
  optimizeDeps: {
    // Prebundle the crypto packages so their CommonJS dependencies work in dev.
    include: ["@pcd/gpc", "@pcd/pod", "@semaphore-protocol/core"]
  }
});
