import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
const { deriveSignerPublicKey } = createRequire(import.meta.url)("@pcd/pod");
const names = {
  healthcare: [
    "Aster Nursing Board",
    "Pulse Training Institute",
    "Harbor Community Clinic",
    "ClearPath Screening",
    "Everwell Occupational Health",
    "Willow Creek Hospital",
  ],
  education: [
    "Westhaven University",
    "Lingua Assessment",
    "Brightpath Foundation",
    "Summit Course Registry",
    "Crescent Education Trust",
    "Northbridge Graduate School",
  ],
  logistics: [
    "ThermoTrace Monitoring",
    "Clearwell Laboratories",
    "Polar Route Transport",
    "Precision Calibration Bureau",
    "Alpine Manufacturing QA",
    "Cedarway Pharmacy",
  ],
};
const dir = path.join(homedir(), ".config/attest/sepolia");
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, "industry-wallets.json");
let bundle;
try {
  bundle = JSON.parse(await readFile(file, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  bundle = {
    version: 1,
    chainId: 11155111,
    profiles: Object.fromEntries(
      Object.entries(names).map(([profile, list]) => [
        profile,
        list.map((name, id) => {
          const evmPrivateKey = generatePrivateKey(),
            credentialPrivateKey = randomBytes(32).toString("hex");
          return {
            id,
            name,
            address: privateKeyToAccount(evmPrivateKey).address,
            credentialPublicKey: deriveSignerPublicKey(credentialPrivateKey),
            evmPrivateKey,
            credentialPrivateKey,
          };
        }),
      ]),
    ),
  };
  await writeFile(file, JSON.stringify(bundle, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
for (const [profile, list] of Object.entries(bundle.profiles))
  list.forEach((item, i) => (item.name = names[profile][i]));
await writeFile(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
await chmod(file, 0o600);
const publicDirectory = {
  chainId: 11155111,
  profiles: Object.fromEntries(
    Object.entries(bundle.profiles).map(([id, list]) => [
      id,
      list.map(({ id, name, address, credentialPublicKey }) => ({
        id,
        name,
        address,
        credentialPublicKey,
      })),
    ]),
  ),
};
await writeFile(
  new URL("../../demo/src/config/industry-wallets.json", import.meta.url),
  JSON.stringify(publicDirectory, null, 2) + "\n",
);
console.log(
  "Provisioned 18 institution wallets; only public directory written to repository.",
);

// Cloudflare text secrets are capped at 5 KB; omit redundant public metadata.
const workerSecret = {
  profiles: Object.fromEntries(
    Object.entries(bundle.profiles).map(([profile, rows]) => [
      profile,
      rows.map(
        ({ evmPrivateKey, credentialPrivateKey, credentialPublicKey }) => ({
          evmPrivateKey,
          credentialPrivateKey,
          credentialPublicKey,
        }),
      ),
    ]),
  ),
};
const compact = JSON.stringify(workerSecret);
if (Buffer.byteLength(compact) > 5000)
  throw new Error(
    "Split institution secrets before deploying; bundle exceeds secret limit",
  );
const workerFile = path.join(dir, "industry-worker-secret.json");
await writeFile(workerFile, compact, { mode: 0o600 });
await chmod(workerFile, 0o600);
console.log(
  "Compact Worker secret prepared outside repository at " + workerFile,
);
