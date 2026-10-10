import { beforeAll, afterAll, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  createPublicClient,
  http,
  type EIP1193Provider,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import {
  fundingNeeded,
  hostOperation,
  sendHostOperation,
  recoverHostOperation,
  validateHostRegistry,
  targetInstitutionBalance,
  type HostProfile,
} from "../src/host-setup";
const url = "http://127.0.0.1:18559";
const reader = createPublicClient({ chain: sepolia, transport: http(url) });
let child: ChildProcess, account: Address;
const provider = {
  request: async (args: unknown) => reader.request(args as never),
} as unknown as EIP1193Provider;
beforeAll(async () => {
  child = spawn(
    process.env.ANVIL_BIN ?? `${homedir()}/.foundry/bin/anvil`,
    [
      "--port",
      "18559",
      "--chain-id",
      "11155111",
      "--block-time",
      "1",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  for (let n = 0; n < 50; n++) {
    try {
      account = (await provider.request({ method: "eth_accounts" }))[0]!;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!account) throw new Error("Anvil failed");
});
afterAll(() => child?.kill());
it("deploys all four, funds 22 wallets, recovers receipts and tops up without redeploying", async () => {
  let addressIndex = 100;
  const configs = [] as HostProfile[];
  for (const [id, count] of [
    ["contractor", 4],
    ["healthcare", 6],
    ["education", 6],
    ["logistics", 6],
  ] as const) {
    const wallets = Array.from(
      { length: count },
      () => `0x${(++addressIndex).toString(16).padStart(40, "0")}` as Address,
    );
    const artifact = JSON.parse(
      readFileSync(
        new URL(
          `../../../apps/web/public/contracts/${count === 4 ? "InstitutionRegistry" : "IndustryRegistry"}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    configs.push({
      id,
      wallets,
      keys: wallets
        .slice(0, -1)
        .map((_, i) => `0x${String(i + 1).repeat(64)}` as Hex),
      artifact,
      ...(count === 6 ? { profile: `0x${"9".repeat(64)}` as Hex } : {}),
    });
  }
  const registries = [] as Address[];
  for (const spec of configs) {
    const op = hostOperation(spec, fundingNeeded(spec.wallets.map(() => 0n)));
    const hash = await sendHostOperation(provider, account, op);
    const registry = await recoverHostOperation(
      provider,
      account,
      spec,
      op,
      hash,
    );
    registries.push(registry);
    expect(await recoverHostOperation(provider, account, spec, op, hash)).toBe(
      registry,
    );
    const balances = await Promise.all(
      spec.wallets.map((address) => reader.getBalance({ address })),
    );
    expect(balances.every((b) => b === targetInstitutionBalance)).toBe(true);
    expect(fundingNeeded(balances)).toBe(0n);
  }
  const spec = configs[1]!;
  const registry = registries[1]!;
  await reader.request({
    method: "anvil_setBalance" as never,
    params: [spec.wallets[0], "0x0"] as never,
  });
  const balance = await Promise.all(
    spec.wallets.map((address) => reader.getBalance({ address })),
  );
  const op = hostOperation(spec, fundingNeeded(balance), registry);
  const hash = await sendHostOperation(provider, account, op);
  expect(await recoverHostOperation(provider, account, spec, op, hash)).toBe(
    registry,
  );
  expect(
    (
      await Promise.all(
        spec.wallets.map((address) => reader.getBalance({ address })),
      )
    ).every((b) => b >= targetInstitutionBalance),
  ).toBe(true);
  await expect(
    validateHostRegistry(
      provider,
      account,
      { ...spec, profile: `0x${"8".repeat(64)}` },
      registry,
    ),
  ).rejects.toThrow("another industry");
});
