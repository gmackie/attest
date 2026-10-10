import { deriveSignerPublicKey } from "@pcd/pod";
import { it, expect } from "vitest";
import path from "node:path";
import { commitValue } from "@attest/core";
import { encryptVault, decryptVault } from "@attest/wallet";
import {
  createJourneyVault,
  issueInstitutionCredential,
  type JourneyVault,
  fictionalInstitutions,
  journeyVaultSchema,
  journeyHolderKey,
  requestJourney,
  prepareJourney,
  verifyJourney,
  journeyNamespace,
} from "../src/testnet-journey";
const testKeys = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
const grantFictionalCredential = (
  v: JourneyVault,
  id: 0 | 1 | 2,
  value: number,
) =>
  issueInstitutionCredential(
    { ...v, holderPublicKey: journeyHolderKey(v) },
    id,
    value,
    testKeys[id]!,
    "44".repeat(32),
    new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10),
  );
const account = "0x1111111111111111111111111111111111111111",
  registry = "0x2222222222222222222222222222222222222222";
const artifacts = path.resolve(
  import.meta.dirname,
  "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
);
function complete() {
  const v = createJourneyVault(
    account,
    registry,
    testKeys.map(deriveSignerPublicKey),
  );
  return {
    ...v,
    credentials: fictionalInstitutions.map((i) =>
      grantFictionalCredential(v, i.id, i.value),
    ),
  };
}
it("binds fictional institution credentials to wallet, registry, holder, values and unique issuer", async () => {
  const v = complete();
  expect(journeyVaultSchema.safeParse(v).success).toBe(true);
  for (const altered of [
    { ...v, account: registry },
    { ...v, registry: account },
    { ...v, id: crypto.randomUUID() },
    {
      ...v,
      credentials: [v.credentials[0], v.credentials[0], v.credentials[2]],
    },
    {
      ...v,
      credentials: v.credentials.map((c, i) => (i ? c : { ...c, value: 99 })),
    },
  ])
    expect(journeyVaultSchema.safeParse(altered).success).toBe(false);
  const encrypted = await encryptVault(
    v,
    "synthetic-test-passphrase",
    journeyNamespace(account, registry),
  );
  const restored = journeyVaultSchema.parse(
    await decryptVault(
      encrypted,
      "synthetic-test-passphrase",
      journeyNamespace(account, registry),
    ),
  );
  expect(restored).toEqual(v);
  await expect(
    decryptVault(
      encrypted,
      "synthetic-test-passphrase",
      journeyNamespace(registry, registry),
    ),
  ).rejects.toThrow();
  const weak = createJourneyVault(
    account,
    registry,
    testKeys.map(deriveSignerPublicKey),
  );
  weak.credentials = fictionalInstitutions.map((i) =>
    grantFictionalCredential(weak, i.id, i.id === 1 ? 1 : i.value),
  );
  await expect(
    prepareJourney(weak, requestJourney(weak), artifacts),
  ).rejects.toThrow("Atlas Field Services");
});
it("proves all three private claims and rejects revoked, substituted, stale and replayed material", async () => {
  const v = complete(),
    request = requestJourney(v),
    p = await prepareJourney(v, request, artifacts);
  const records = await Promise.all(
    v.credentials.map(async (c) => ({
      content: await commitValue(c.contentID),
      holderKey: await commitValue(journeyHolderKey(v)),
      validUntil: BigInt(Date.parse(c.validThrough) / 1000 + 86399),
      revoked: false,
    })),
  );
  const now = BigInt(Math.floor(Date.now() / 1000));
  expect(
    (await verifyJourney(p, request, records, now, artifacts)).every(
      (c) => c.pass,
    ),
  ).toBe(true);
  expect(
    (
      await verifyJourney(
        p,
        { ...request, id: crypto.randomUUID() },
        records,
        now,
        artifacts,
      )
    ).some((c) => !c.pass),
  ).toBe(true);
  expect(
    (
      await verifyJourney(
        p,
        { ...request, expiresAt: new Date(Date.now() - 1000).toISOString() },
        records,
        now,
        artifacts,
      )
    )[0]?.pass,
  ).toBe(false);
  for (const changed of [
    { ...records[1]!, revoked: true },
    { ...records[1]!, content: records[0]!.content },
    { ...records[1]!, holderKey: "0x" + "0".repeat(64) },
    { ...records[1]!, validUntil: 1n },
  ]) {
    expect(
      (
        await verifyJourney(
          p,
          request,
          [records[0]!, changed, records[2]!],
          now,
          artifacts,
        )
      )[2]?.pass,
    ).toBe(false);
  }
  const swapped = { ...p, proofs: [p.proofs[1]!, p.proofs[0]!, p.proofs[2]!] };
  expect(
    (await verifyJourney(swapped, request, records, now, artifacts))[0]?.pass,
  ).toBe(false);
  await expect(
    prepareJourney(v, { ...request, registry: account }, artifacts),
  ).rejects.toThrow();
}, 120000);
