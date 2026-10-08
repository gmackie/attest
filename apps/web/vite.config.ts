import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ["buffer", "crypto", "events", "process", "stream", "util"],
      globals: { Buffer: true, global: true, process: true }
    })
  ],
  build: {
    target: "es2022",
    sourcemap: true
  },
  optimizeDeps: {
    exclude: ["@pcd/gpc", "@pcd/pod", "@semaphore-protocol/core"]
  }
});
