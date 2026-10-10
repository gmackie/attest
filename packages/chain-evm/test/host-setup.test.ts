import { describe, it, expect, vi } from "vitest";
import {
  fundingNeeded,
  targetInstitutionBalance,
  hostOperation,
  recoverHostOperation,
  type HostProfile,
} from "../src/host-setup";
import type { Address, Hex, EIP1193Provider } from "viem";
const a = "0x1111111111111111111111111111111111111111" as Address;
const registry = "0x2222222222222222222222222222222222222222" as Address;
const spec = {
  id: "contractor",
  wallets: [a, a, a, a],
  keys: [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, `0x${"3".repeat(64)}`],
  artifact: { bytecode: "0x6000", deployedBytecode: "0x6000" },
} as HostProfile;
describe("host funding", () => {
  it("funds all 22 empty wallets to the target", () => {
    expect(
      fundingNeeded([0n, 0n, 0n, 0n]) +
        3n * fundingNeeded([0n, 0n, 0n, 0n, 0n, 0n]),
    ).toBe(22000000000000000n);
  });
  it("skips funded wallets and computes equal-split topups from the lowest balance", () => {
    expect(
      fundingNeeded([targetInstitutionBalance, 2n * targetInstitutionBalance]),
    ).toBe(0n);
    expect(fundingNeeded([targetInstitutionBalance - 5n, 0n])).toBe(
      2n * targetInstitutionBalance,
    );
    expect(() => fundingNeeded([])).toThrow();
  });
  it("bounds amounts and distinguishes funding from deployment", () => {
    expect(() => hostOperation(spec, 100000000000000001n)).toThrow();
    expect(hostOperation(spec, 1n, registry)).toMatchObject({
      kind: "fund",
      to: registry,
      value: 1n,
    });
    expect(hostOperation(spec, 1n)).toMatchObject({
      kind: "deploy",
      value: 1n,
    });
  });
  it("refuses recovery on mainnet before reading a transaction", async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === "eth_chainId" ? "0x1" : [a],
    );
    await expect(
      recoverHostOperation(
        { request } as unknown as EIP1193Provider,
        a,
        spec,
        hostOperation(spec, 1n),
        `0x${"4".repeat(64)}` as Hex,
      ),
    ).rejects.toThrow("Switch");
    expect(
      request.mock.calls.every(([r]) => r.method !== "eth_sendTransaction"),
    ).toBe(true);
  });
  it("rejects a journal hash belonging to a different operation", async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === "eth_chainId"
        ? "0xaa36a7"
        : method === "eth_accounts"
          ? [a]
          : {
              hash: `0x${"4".repeat(64)}`,
              from: a,
              to: registry,
              input: "0x",
              value: "0x0",
              blockHash: null,
              blockNumber: null,
              transactionIndex: null,
              gas: "0x5208",
              gasPrice: "0x1",
              nonce: "0x0",
              type: "0x0",
            },
    );
    await expect(
      recoverHostOperation(
        { request } as unknown as EIP1193Provider,
        a,
        spec,
        hostOperation(spec, 1n),
        `0x${"4".repeat(64)}` as Hex,
      ),
    ).rejects.toThrow("does not match");
  });
});
