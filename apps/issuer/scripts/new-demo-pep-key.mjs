#!/usr/bin/env node
/**
 * Generates a P-256 signing key for the demo PEP (ATTE-20) in attest-demo.
 *
 * stdout: the secret JSON {active, keys:[{kid, privateKey}]}.
 * stderr: the public JWK (kid, alg, use) and the attest-verifier entry to add (TRUSTED_PEPS for the
 *         request key, IDENTITY_PROVIDERS for the identity key). Nothing is written to disk.
 *
 *   node apps/issuer/scripts/new-demo-pep-key.mjs request  | pnpm exec wrangler secret put DEMO_PEP_SIGNING_KEY
 *   node apps/issuer/scripts/new-demo-pep-key.mjs identity | pnpm exec wrangler secret put DEMO_IDENTITY_SIGNING_KEY
 *
 * Rotation: pass the current secret JSON on stdin with --merge-stdin, straight from your password manager,
 * so it never touches the disk. The new key becomes active; old keys stay published until removed:
 *
 *   pbpaste | node apps/issuer/scripts/new-demo-pep-key.mjs request --merge-stdin | pnpm exec wrangler secret put DEMO_PEP_SIGNING_KEY
 *
 * Options: --kid <kid>, --issuer <demo PEP issuer> (default https://attest.gmac.io/api/demo-pep),
 *          --verifier <verifier id> (default https://verify.attest.gmac.io).
 */
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v) { console.error(`${name} needs a value`); process.exit(2); }
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
if (args.includes("--merge")) {
  console.error("--merge <file> was removed: pipe the current secret on stdin with --merge-stdin, so it is never written to disk.");
  process.exit(2);
}
const kidArg = opt("--kid"), issuer = opt("--issuer") ?? "https://attest.gmac.io/api/demo-pep";
const verifier = opt("--verifier") ?? "https://verify.attest.gmac.io";
const merge = flag("--merge-stdin");
const purpose = args[0];
if (purpose !== "request" && purpose !== "identity") {
  console.error("usage: new-demo-pep-key.mjs request|identity [--kid kid] [--issuer url] [--verifier url] [--merge-stdin]");
  process.exit(2);
}
const kid = kidArg ?? `demo-pep-${purpose}-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(kid)) {
  console.error("kid must match [A-Za-z0-9._:-]{1,128}");
  process.exit(2);
}
let keys = [];
if (merge) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const existing = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(existing.keys)) throw new Error("existing secret has no keys[]");
  if (existing.keys.some((k) => k.kid === kid)) throw new Error(`kid ${kid} already exists`);
  keys = existing.keys;
}
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const privateKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
const publicKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
process.stdout.write(JSON.stringify({ active: kid, keys: [...keys, { kid, privateKey }] }) + "\n");
process.stderr.write(JSON.stringify({ kid, alg: "ES256", use: "sig", publicKey }, null, 2) + "\n");
if (purpose === "request")
  process.stderr.write("attest-verifier TRUSTED_PEPS entry (add every published kid):\n" +
    JSON.stringify({ issuer, keys: [{ kid, publicKey }] }) + "\n");
else
  process.stderr.write("attest-verifier IDENTITY_PROVIDERS entry:\n" + JSON.stringify({
    issuer: `${issuer}/identity`, jwksUri: `${issuer}/identity/jwks`, audience: verifier,
    clientId: "attest-vendor-portal-demo", bindingTtlMs: 86_400_000,
  }) + "\n");
