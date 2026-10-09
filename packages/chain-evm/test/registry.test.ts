import { beforeAll, afterAll, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { registryAbi } from "../src/connected";
const binary =
  process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const port = 18545,
  url = `http://127.0.0.1:${port}`;
let processHandle: ChildProcess, registry: Address, accounts: Address[];
const reader = createPublicClient({ chain: sepolia, transport: http(url) });
const wallet = createWalletClient({ chain: sepolia, transport: http(url) });
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
beforeAll(async () => {
  if (!existsSync(binary)) return;
  const root = path.resolve(import.meta.dirname, "../../..");
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], {
    cwd: path.join(root, "contracts"),
    encoding: "utf8",
  });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  processHandle = spawn(
    binary,
    ["--port", String(port), "--chain-id", "11155111", "--silent"],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 50; i++) {
    try {
      accounts = await wallet.getAddresses();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!accounts) throw new Error("Anvil failed to start");
  const artifact = JSON.parse(
    readFileSync(
      path.join(root, "contracts/artifacts/WorkspaceRegistry.json"),
      "utf8",
    ),
  );
  const tx = await wallet.deployContract({
    account: accounts[0]!,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  });
  registry = (await reader.waitForTransactionReceipt({ hash: tx }))
    .contractAddress!;
}, 30000);
afterAll(() => {
  processHandle?.kill();
});
it.skipIf(!existsSync(binary))(
  "registry enforces scoped grants, original-issuer permanent revocation and verifier replay protection",
  async () => {
    const admin = accounts[0]!,
      issuer = accounts[1]!,
      stranger = accounts[2]!,
      scope = hash("1"),
      credential = hash("2"),
      commitment = hash("3"),
      keyHash = hash("4"),
      request = hash("5");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const write = async (
      account: Address,
      functionName:
        | "configureIssuer"
        | "configureVerifier"
        | "anchor"
        | "revoke"
        | "recordDecision",
      args: readonly unknown[],
    ) => {
      const sim = await reader.simulateContract({
        address: registry,
        abi: registryAbi,
        functionName,
        args: args as never,
        account,
      });
      const tx = await wallet.writeContract(sim.request);
      return reader.waitForTransactionReceipt({ hash: tx });
    };
    await expect(
      write(stranger, "configureIssuer", [issuer, scope, keyHash, true]),
    ).rejects.toThrow();
    await expect(
      write(issuer, "anchor", [credential, scope, commitment, deadline]),
    ).rejects.toThrow();
    await write(admin, "configureIssuer", [issuer, scope, keyHash, true]);
    await expect(
      write(issuer, "anchor", [credential, hash("a"), commitment, deadline]),
    ).rejects.toThrow();
    await expect(
      write(issuer, "anchor", [credential, scope, commitment, 1n]),
    ).rejects.toThrow();
    await write(issuer, "anchor", [credential, scope, commitment, deadline]);
    await expect(
      write(issuer, "anchor", [credential, scope, commitment, deadline]),
    ).rejects.toThrow();
    await expect(write(stranger, "revoke", [credential])).rejects.toThrow();
    await write(issuer, "revoke", [credential]);
    expect(
      (
        await reader.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "anchors",
          args: [credential],
        })
      )[4],
    ).toBe(true);
    await expect(write(issuer, "revoke", [credential])).rejects.toThrow();
    await expect(
      write(stranger, "recordDecision", [request, commitment, true]),
    ).rejects.toThrow();
    await write(admin, "configureVerifier", [stranger, true]);
    await write(stranger, "recordDecision", [request, commitment, true]);
    await expect(
      write(stranger, "recordDecision", [request, commitment, true]),
    ).rejects.toThrow();
    await write(admin, "configureVerifier", [stranger, false]);
    await expect(
      write(stranger, "recordDecision", [hash("6"), commitment, true]),
    ).rejects.toThrow();
  },
  30000,
);
