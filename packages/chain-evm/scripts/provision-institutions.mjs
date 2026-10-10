import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
const { deriveSignerPublicKey } = createRequire(import.meta.url)("@pcd/pod");
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
const dir = path.join(homedir(), ".config/attest/sepolia");
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, "institution-wallets.json");
let bundle;
try {
  bundle = JSON.parse(await readFile(file, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  bundle = {
    version: 1,
    chainId: 11155111,
    createdAt: new Date().toISOString(),
    institutions: [
      "Cedar Skills Academy",
      "Atlas Field Services",
      "Harbor Mutual",
      "Northstar Procurement",
    ].map((name, id) => {
      const evmPrivateKey = generatePrivateKey(),
        credentialPrivateKey = randomBytes(32).toString("hex");
      return {
        id,
        name,
        evmPrivateKey,
        address: privateKeyToAccount(evmPrivateKey).address,
        credentialPrivateKey,
        credentialPublicKey: deriveSignerPublicKey(credentialPrivateKey),
      };
    }),
  };
  await writeFile(file, JSON.stringify(bundle, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
await chmod(file, 0o600);
console.log(
  JSON.stringify(
    {
      chainId: bundle.chainId,
      secretFile: file,
      institutions: bundle.institutions.map(
        ({ id, name, address, credentialPublicKey }) => ({
          id,
          name,
          address,
          credentialPublicKey,
        }),
      ),
    },
    null,
    2,
  ),
);
