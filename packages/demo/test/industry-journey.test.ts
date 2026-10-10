import { it, expect, beforeAll } from "vitest";
import path from "node:path";
import { deriveSignerPublicKey } from "@pcd/pod";
import { commitValue } from "@attest/core";
import {
  industryIds,
  industryWallets,
  industryDefinition,
  newIndustryVault,
  industryCommandSchema,
  issueIndustryCredential,
  parseIndustryVault,
  requestIndustry,
  prepareIndustry,
  verifyIndustry,
  type ConnectedIndustry,
  type IndustryVault,
} from "../src/industry-journey";
const keys = Array.from({ length: 5 }, (_, i) =>
  (i + 1).toString(16).padStart(2, "0").repeat(32),
);
beforeAll(() => {
  for (const id of industryIds)
    industryWallets[id]
      .slice(0, 5)
      .forEach(
        (entry, i) =>
          (entry.credentialPublicKey = deriveSignerPublicKey(keys[i]!)),
      );
});
const artifacts = path.resolve(
  import.meta.dirname,
  "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
);
function complete(id: ConnectedIndustry): IndustryVault {
  const v = newIndustryVault(
    id,
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  );
  v.credentials = industryDefinition(id).sources.map((s, i) =>
    issueIndustryCredential(
      industryCommandSchema.parse({
        industry: v.industry,
        account: v.account,
        registry: v.registry,
        journey: v.journey,
        holderPublicKey: v.holderPublicKey,
        version: 1,
        chainId: 11155111,
        domain: "attest.gmac.io",
        action: "issue",
        institution: i,
        fields: Object.fromEntries(s.fields.map((f) => [f.id, f.value])),
        validThrough: new Date(Date.now() + 86400000 * 180)
          .toISOString()
          .slice(0, 10),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        nonce: crypto.randomUUID(),
        demoConsent: true,
      }),
      keys[i]!,
      "aa".repeat(32),
    ),
  );
  return v;
}
it.each(industryIds)(
  "%s verifies five source proofs and rejects profile, contract, source, holder and status substitutions",
  async (id) => {
    const v = complete(id);
    expect(parseIndustryVault(v)).toEqual(v);
    for (const changed of [
      { ...v, industry: industryIds.find((x) => x !== id)! },
      { ...v, account: v.registry },
      { ...v, journey: crypto.randomUUID() },
      {
        ...v,
        credentials: [
          v.credentials[0]!,
          v.credentials[0]!,
          ...v.credentials.slice(2),
        ],
      },
    ])
      expect(() => parseIndustryVault(changed)).toThrow();
    const r = await requestIndustry(v, "standard"),
      p = await prepareIndustry(v, r, artifacts);
    const records = await Promise.all(
      v.credentials.map(async (c) => ({
        content: await commitValue(c.contentID),
        holderKey: await commitValue(v.holderPublicKey),
        validUntil: BigInt(Date.parse(c.validThrough) / 1000 + 86399),
        revoked: false,
      })),
    );
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(
      (await verifyIndustry(p, r, records, now, artifacts)).every(
        (c) => c.pass,
      ),
    ).toBe(true);
    const revoked = records.map((r, i) => ({ ...r, revoked: i === 2 }));
    expect((await verifyIndustry(p, r, revoked, now, artifacts))[3]!.pass).toBe(
      false,
    );
    expect(
      (
        await verifyIndustry(
          p,
          { ...r, id: crypto.randomUUID() },
          records,
          now,
          artifacts,
        )
      ).every((c) => c.pass),
    ).toBe(false);
    await expect(
      verifyIndustry(p, { ...r, level: "critical" }, records, now, artifacts),
    ).rejects.toThrow("Wrong contract");
    await expect(
      prepareIndustry(v, await requestIndustry(v, "critical"), artifacts),
    ).rejects.toThrow();
    const changed = {
      ...p,
      proofs: [p.proofs[1]!, p.proofs[0]!, ...p.proofs.slice(2)],
    };
    expect(
      (await verifyIndustry(changed, r, records, now, artifacts))[0]!.pass,
    ).toBe(false);
  },
  180000,
);

it("rejects a source license that meets the historical agreement date but expires before this request", async () => {
  const v = complete("healthcare");
  const command = industryCommandSchema.parse({
    industry: v.industry,
    account: v.account,
    registry: v.registry,
    journey: v.journey,
    holderPublicKey: v.holderPublicKey,
    version: 1,
    chainId: 11155111,
    domain: "attest.gmac.io",
    action: "issue",
    institution: 0,
    fields: { status: "active", validThrough: "2026-10-08" },
    validThrough: new Date(Date.now() + 86400000 * 30)
      .toISOString()
      .slice(0, 10),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    nonce: crypto.randomUUID(),
    demoConsent: true,
  });
  v.credentials[0] = issueIndustryCredential(
    command,
    keys[0]!,
    "ab".repeat(32),
  );
  await expect(
    prepareIndustry(v, await requestIndustry(v, "standard"), artifacts),
  ).rejects.toThrow("validThrough does not satisfy");
});

it('rejects an incoherent sensor range before signing', async()=>{
 const {validateIndustryFields}=await import('../src/industry-journey');
 expect(()=>validateIndustryFields('logistics',0,{minimum:7,maximum:3})).toThrow('Minimum temperature');
});
