#!/usr/bin/env node
/**
 * Generates a P-256 result-signing key for attest-verifier.
 *
 * stdout: the RESULT_SIGNING_KEYS secret JSON {active, keys:[{kid, privateKey}]}.
 * stderr: the public JWK (kid, alg, use) to pin in Gatekeeper's ATTEST_CONFIG.verifiers[].
 * Nothing is written to disk.
 *
 *   node apps/verifier/scripts/new-result-key.mjs [kid] [--merge <existing secret JSON file>]
 *   node apps/verifier/scripts/new-result-key.mjs | pnpm exec wrangler secret put RESULT_SIGNING_KEYS -c apps/verifier/wrangler.jsonc
 *
 * For rotation, pass --merge with the current secret JSON (read from your password manager, not
 * this repo): the new key becomes active and existing keys stay published in the JWKS until removed.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const mergeAt = args.indexOf("--merge");
const mergePath = mergeAt >= 0 ? args[mergeAt + 1] : undefined;
if (mergeAt >= 0 && !mergePath) {
  console.error("--merge needs a file path");
  process.exit(2);
}
const positional = mergeAt >= 0 ? args.filter((_, i) => i !== mergeAt && i !== mergeAt + 1) : args;
const kid = positional[0] ?? `verifier-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(kid)) {
  console.error("kid must match [A-Za-z0-9._:-]{1,128}");
  process.exit(2);
}

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const privateKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
const publicKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };

let keys = [];
if (mergePath) {
  const existing = JSON.parse(readFileSync(mergePath, "utf8"));
  if (!Array.isArray(existing.keys)) throw new Error("existing secret has no keys[]");
  if (existing.keys.some((k) => k.kid === kid)) throw new Error(`kid ${kid} already exists`);
  keys = existing.keys;
}
process.stdout.write(JSON.stringify({ active: kid, keys: [...keys, { kid, privateKey }] }) + "\n");
process.stderr.write(JSON.stringify({ kid, alg: "ES256", use: "sig", publicKey }, null, 2) + "\n");
