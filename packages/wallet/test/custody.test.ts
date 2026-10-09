import { it, expect } from "vitest";
import { encryptVault, decryptVault } from "../src/custody";
it("encrypted custody round trips without plaintext and rejects wrong passphrase, context or tampering", async () => {
  const payload = {
    privateKey: "never-upload",
    credentials: [{ subject: "private-person" }],
  };
  const a = await encryptVault(
    payload,
    "correct horse battery",
    "chain:11155111:account:alice",
  );
  const b = await encryptVault(
    payload,
    "correct horse battery",
    "chain:11155111:account:alice",
  );
  expect(a.ciphertext).not.toBe(b.ciphertext);
  expect(JSON.stringify(a)).not.toContain("private-person");
  expect(await decryptVault(a, "correct horse battery", a.namespace)).toEqual(
    payload,
  );
  await expect(
    decryptVault(a, "wrong passphrase here", a.namespace),
  ).rejects.toThrow();
  await expect(
    decryptVault(a, "correct horse battery", "chain:1:account:alice"),
  ).rejects.toThrow();
  await expect(
    decryptVault(
      { ...a, ciphertext: "AAAA" },
      "correct horse battery",
      a.namespace,
    ),
  ).rejects.toThrow();
  await expect(encryptVault(payload, "short", a.namespace)).rejects.toThrow();
});
