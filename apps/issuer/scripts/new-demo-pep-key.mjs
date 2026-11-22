#!/usr/bin/env node
/**
 * Generates a P-256 signing key for the demo PEP (ATTE-20) in attest-demo.
 *
 * stdout: the secret JSON {active, keys:[{kid, privateKey}]}.
 * stderr: the public JWK (kid, alg, use) and, for the request key, the TRUSTED_PEPS entry to add
 *         to attest-verifier. Nothing is written to disk.
 *
 *   node apps/issuer/scripts/new-demo-pep-key.mjs request  | pnpm exec wrangler secret put DEMO_PEP_SIGNING_KEY
 *   node apps/issuer/scripts/new-demo-pep-key.mjs identity | pnpm exec wrangler secret put DEMO_IDENTITY_SIGNING_KEY
 *
 * Options: --kid <kid>, --issuer <demo PEP issuer> (default https://attest.gmac.io/api/demo-pep),
 *          --merge <current secret JSON file> to rotate (the new key becomes active, old keys stay published).
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v) { console.error(`${name} needs a value`); process.exit(2); }
  args.splice(i, 2);
  return v;
};
const kidArg = opt("--kid"), issuer = opt("--issuer") ?? "https://attest.gmac.io/api/demo-pep", mergePath = opt("--merge");
const purpose = args[0];
if (purpose !== "request" && purpose !== "identity") {
  console.error("usage: new-demo-pep-key.mjs request|identity [--kid kid] [--issuer url] [--merge file]");
  process.exit(2);
}
const kid = kidArg ?? `demo-pep-${purpose}-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
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
if (purpose === "request")
  process.stderr.write("attest-verifier TRUSTED_PEPS entry:\n" +
    JSON.stringify({ issuer, keys: [{ kid, publicKey }] }) + "\n");
else
  process.stderr.write("attest-verifier IDENTITY_PROVIDERS entry:\n" +
    JSON.stringify({ issuer: `${issuer}/identity`, jwksUri: `${issuer}/identity/jwks`, audience: "https://verify.attest.gmac.io" }) + "\n");
