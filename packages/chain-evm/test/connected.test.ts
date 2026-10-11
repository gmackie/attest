import { it, expect } from "vitest";
import {
  assertContext,
  checkedHash,
  custodyNamespace,
  deployRegistry,
  submitRegistryAction,
  type RegistryAction,
  type EIP1193Provider,
} from "../src/connected";
const account = "0x1111111111111111111111111111111111111111";
it("separates network/account custody and blocks production writes and stale account context", async () => {
  const provider = {
    request: async ({ method }: { method: string }) =>
      method === "eth_chainId" ? "0xaa36a7" : [account],
  } as unknown as EIP1193Provider;
  await assertContext(provider, "testnet", account, true);
  await expect(
    assertContext(provider, "production", account, true),
  ).rejects.toThrow("Production writes");
  await expect(assertContext(provider, "production", account)).rejects.toThrow(
    "Switch",
  );
  await expect(
    assertContext(
      provider,
      "testnet",
      "0x2222222222222222222222222222222222222222",
    ),
  ).rejects.toThrow("Account changed");
  expect(custodyNamespace("testnet", account)).not.toBe(
    custodyNamespace("production", account),
  );
  expect(() => checkedHash("private document text")).toThrow();
});

it("rejects every mainnet registry write before contacting the wallet or RPC", async () => {
  const calls: string[] = [];
  const provider = {
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      throw new Error("The mainnet gate must run before provider access");
    },
  } as unknown as EIP1193Provider;
  const registry = "0x2222222222222222222222222222222222222222";
  const functions: RegistryAction["functionName"][] = [
    "configureIssuer", "configureVerifier", "anchor", "revoke", "recordDecision",
  ];
  for (const functionName of functions) {
    await expect(submitRegistryAction(provider, "production", account, registry, {
      functionName, args: [],
    })).rejects.toThrow("Production writes are disabled");
  }
  await expect(deployRegistry(provider, "production", account, "0x6000"))
    .rejects.toThrow("Production writes are disabled");
  expect(calls).toEqual([]);
});
