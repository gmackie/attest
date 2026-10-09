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
import { industryAbi as journeyAbi } from "../src/industry";
const binary =
  process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const port = 18548,
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
      path.join(root, "contracts/artifacts/IndustryRegistry.json"),
      "utf8",
    ),
  );
  const tx = await wallet.deployContract({
    account: accounts[0]!,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [
      hash("f"),
      [
        accounts[0],
        accounts[1],
        accounts[2],
        accounts[3],
        accounts[4],
        accounts[5],
      ],
      [hash("a"), hash("b"), hash("c"), hash("d"), hash("e")],
    ],
  });
  registry = (await reader.waitForTransactionReceipt({ hash: tx }))
    .contractAddress!;
}, 30000);
afterAll(() => {
  processHandle?.kill();
});
it.skipIf(!existsSync(binary))(
  "industry registry enforces five issuer scopes and separate verifier authority",
  async () => {
    expect(
      await reader.readContract({
        address: registry,
        abi: journeyAbi,
        functionName: "profile",
      }),
    ).toBe(hash("f"));
    const issuer = accounts[0]!,
      other = accounts[1]!,
      holder = accounts[6]!,
      verifier = accounts[5]!,
      journey = hash("1"),
      content = hash("2"),
      key = hash("3"),
      deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const write = async (
      account: Address,
      functionName: "grant" | "revoke" | "recordDecision",
      args: readonly unknown[],
    ) => {
      const sim = await reader.simulateContract({
        account,
        address: registry,
        abi: journeyAbi,
        functionName,
        args: args as never,
      });
      const tx = await wallet.writeContract(sim.request);
      return reader.waitForTransactionReceipt({ hash: tx });
    };
    await expect(
      write(holder, "grant", [holder, journey, 0, content, key, deadline]),
    ).rejects.toThrow();
    await expect(
      write(other, "grant", [holder, journey, 0, content, key, deadline]),
    ).rejects.toThrow();
    await expect(
      write(issuer, "grant", [holder, journey, 0, content, key, 1n]),
    ).rejects.toThrow();
    await write(issuer, "grant", [holder, journey, 0, content, key, deadline]);
    await expect(
      write(issuer, "grant", [holder, journey, 0, content, key, deadline]),
    ).rejects.toThrow();
    await expect(
      write(holder, "revoke", [holder, journey, 0]),
    ).rejects.toThrow();
    await expect(
      write(other, "revoke", [holder, journey, 0]),
    ).rejects.toThrow();
    await write(issuer, "revoke", [holder, journey, 0]);
    expect(
      (
        await reader.readContract({
          address: registry,
          abi: journeyAbi,
          functionName: "records",
          args: [holder, journey, 0],
        })
      )[3],
    ).toBe(true);
    await expect(
      write(issuer, "revoke", [holder, journey, 0]),
    ).rejects.toThrow();
    await expect(
      write(holder, "recordDecision", [holder, journey, content]),
    ).rejects.toThrow();
    await expect(
      write(issuer, "recordDecision", [holder, journey, content]),
    ).rejects.toThrow();
    await write(verifier, "recordDecision", [holder, journey, content]);
    await expect(
      write(verifier, "recordDecision", [holder, journey, content]),
    ).rejects.toThrow();
  },
  30000,
);
