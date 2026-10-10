import { it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import worker, { InstitutionService } from "../../../apps/issuer/src/index";
import {
  commandMessage,
  institutionCommandSchema,
} from "../../demo/src/institution-service";
import { journeyProfile } from "../../demo/src/testnet-journey";
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const command = () =>
  institutionCommandSchema.parse({
    version: 2,
    chainId: 11155111,
    profile: journeyProfile,
    domain: "attest.gmac.io",
    action: "issue",
    account: account.address,
    registry: "0x2222222222222222222222222222222222222222",
    journey: crypto.randomUUID(),
    holderPublicKey: "a".repeat(43),
    institution: 0,
    value: 40,
    validThrough: "2026-12-01",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    nonce: crypto.randomUUID(),
    demoConsent: true,
  });
it("rejects altered and expired wallet authorizations before any chain access", async () => {
  const service = new InstitutionService({} as never, {} as never);
  const c = command();
  const signature = await account.signMessage({ message: commandMessage(c) });
  const send = (command: unknown) =>
    service.fetch(
      new Request("https://institution.internal/api/v2/credentials", {
        method: "POST",
        body: JSON.stringify({ command, signature }),
      }),
    );
  for (const changed of [
    { ...c, value: 41 },
    { ...c, institution: 1 },
    { ...c, action: "revoke" },
    { ...c, journey: crypto.randomUUID() },
    { ...c, expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const r = await send(changed);
    expect(r.status).toBe(401);
  }
});
it("bounds streamed bodies even without content-length and rejects unknown API routes", async () => {
  const env = {} as never;
  const large = await worker.fetch(
    new Request("https://attest.gmac.io/api/v2/credentials", {
      method: "POST",
      body: "x".repeat(100001),
    }),
    env,
  );
  expect(large.status).toBe(413);
  const invalid = await worker.fetch(
    new Request("https://attest.gmac.io/api/v2/credentials", {
      method: "POST",
      body: "{}",
    }),
    env,
  );
  expect(invalid.status).toBe(400);
  expect(
    (
      await worker.fetch(
        new Request("https://attest.gmac.io/api/private-key"),
        env,
      )
    ).status,
  ).toBe(404);
});

it("industry requests cannot change profile, institution or claim fields after wallet signing", async () => {
  const { industryCommandSchema, industryCommandMessage } =
    await import("../../demo/src/industry-journey");
  const { profile: _, value: __, ...base } = command();
  const c = industryCommandSchema.parse({
    ...base,
    version: 1,
    industry: "healthcare",
    fields: { status: "active", validThrough: "2027-12-31" },
  });
  const signature = await account.signMessage({
    message: industryCommandMessage(c),
  });
  const service = new InstitutionService({} as never, {} as never);
  for (const changed of [
    { ...c, industry: "education" },
    { ...c, institution: 1 },
    { ...c, fields: { ...c.fields, status: "suspended" } },
    { ...c, registry: account.address },
  ]) {
    const r = await service.fetch(
      new Request("https://institution.internal/api/v3/credentials", {
        method: "POST",
        body: JSON.stringify({ command: changed, signature }),
      }),
    );
    expect(r.status).toBe(401);
  }
});
