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
import { journeyAbi } from "../src/journey";
const binary =
  process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const port = 18547,
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
      path.join(root, "contracts/artifacts/DemoJourneyRegistry.json"),
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
  "fictional Sepolia registry isolates holders, prevents overwrite and replay, and revokes permanently",
  async () => {
    const a = accounts[0]!,
      b = accounts[1]!,
      journey = hash("1"),
      content = hash("2"),
      key = hash("3");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const write = async (
      account: Address,
      functionName: "grant" | "revoke" | "recordReceipt",
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
      write(a, "grant", [journey, 3, content, key, deadline]),
    ).rejects.toThrow();
    await expect(
      write(a, "grant", [journey, 0, content, key, 1n]),
    ).rejects.toThrow();
    await expect(
      write(a, "grant", [journey, 0, content, key, deadline + 400n * 86400n]),
    ).rejects.toThrow();
    await write(a, "grant", [journey, 0, content, key, deadline]);
    await expect(
      write(a, "grant", [journey, 0, hash("4"), key, deadline]),
    ).rejects.toThrow();
    await expect(write(b, "revoke", [journey, 0])).rejects.toThrow();
    await write(b, "grant", [journey, 0, hash("4"), key, deadline]);
    expect(
      (
        await reader.readContract({
          address: registry,
          abi: journeyAbi,
          functionName: "records",
          args: [a, journey, 0],
        })
      )[0],
    ).toBe(content);
    await write(a, "revoke", [journey, 0]);
    expect(
      (
        await reader.readContract({
          address: registry,
          abi: journeyAbi,
          functionName: "records",
          args: [a, journey, 0],
        })
      )[3],
    ).toBe(true);
    await expect(write(a, "revoke", [journey, 0])).rejects.toThrow();
    await write(a, "recordReceipt", [journey, content]);
    await expect(
      write(a, "recordReceipt", [journey, content]),
    ).rejects.toThrow();
    await write(b, "recordReceipt", [journey, content]);
  },
  30000,
);
