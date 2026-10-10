import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const base = new URL(process.env.ATTEST_VERIFY_URL ?? "https://attest.gmac.io");
const root = path.resolve(import.meta.dirname, "../apps/web/dist");
const index = await readFile(path.join(root, "index.html"));
const assets = [...index.toString().matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
const contracts = (await readdir(path.join(root, "contracts"))).filter((name) => name.endsWith(".json"));
const paths = ["/", ...assets, ...contracts.map((name) => `/contracts/${name}`), "/demo-deployment.json", "/industry-deployments.json"];
const evidence = [];
for (const resource of paths) {
  const response = await fetch(new URL(resource, base), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${resource}: HTTP ${response.status}`);
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = resource === "/" ? index : await readFile(path.join(root, resource.slice(1)));
  if (!actual.equals(expected)) throw new Error(`${resource}: live bytes differ from build`);
  evidence.push({ resource, status: response.status, sha256: createHash("sha256").update(actual).digest("hex") });
}
for (const version of [2, 3]) {
  const resource = `/api/v${version}/institutions`;
  const response = await fetch(new URL(resource, base), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${resource}: HTTP ${response.status}`);
  const directory = await response.json();
  if (!directory.serviceConfigured || directory.chainId !== 11155111) throw new Error(`${resource}: issuer service is not configured for Sepolia`);
  if (version === 2 ? directory.institutions?.length !== 4 :
      Object.keys(directory.profiles ?? {}).length !== 3 || Object.values(directory.profiles).some((institutions) => institutions.length !== 6)) {
    throw new Error(`${resource}: institution inventory differs`);
  }
  evidence.push({ resource, status: response.status, serviceConfigured: true });
}
console.log(JSON.stringify({ url: base.origin, checkedAt: new Date().toISOString(), evidence }, null, 2));
