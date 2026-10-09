// Node 24 cannot infer blakejs's named exports from its CommonJS object literal.
// Adapt only ESM imports of that dependency; the browser bundle uses Vite's interop.
import { registerHooks } from "node:module";
const suffix = "?attest-blakejs-interop";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return specifier === "blakejs" && context.conditions.includes("import")
      ? { ...result, url: result.url + suffix }
      : result;
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(suffix)) return nextLoad(url, context);
    const original = url.slice(0, -suffix.length);
    return {
      format: "module",
      shortCircuit: true,
      source: `import { createRequire } from 'node:module';
        const implementation = createRequire(${JSON.stringify(original)})('./index.js');
        export const { blake2b, blake2bHex, blake2bInit, blake2bUpdate, blake2bFinal,
          blake2s, blake2sHex, blake2sInit, blake2sUpdate, blake2sFinal } = implementation;
        export default implementation;`,
    };
  },
});
await import("./main.ts");
