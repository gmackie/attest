import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveSignerPublicKey } from "@pcd/pod";
import { entitlementNullifier, type Hex } from "@attest/chain-evm";
import {
  CONVERSION_CLAIM_SCHEMA, authorizePrivateConversion, issueConversionClaim,
  preparePrivateConversion, verifyPrivateConversion,
  type ConversionPolicy, type ConversionIntent, type ConversionVerifierPorts,
  type PrivateConversionPresentation,
} from "../src/conversion";

const digest = (c: string) => `0x${c.repeat(64)}` as Hex;
const issuerKey = "9".repeat(64);
const holderKey = "1".repeat(64);
const issuerPub = deriveSignerPublicKey(issuerKey);
const holderPub = deriveSignerPublicKey(holderKey);
const account = "0x1111111111111111111111111111111111111111" as const;
const token = "0x2222222222222222222222222222222222222222" as const;
const issuerAccount = "0x3333333333333333333333333333333333333333" as const;
const issuerScope = digest("2");
const event = digest("e");
const policy: ConversionPolicy = {
  id: digest("a"), schema: CONVERSION_CLAIM_SCHEMA, scope: issuerScope,
  minimumScore: 700, mintAmount: 200n * 10n ** 18n, palette: [5500, 2500, 1500, 500],
};
const now = () => Date.now();
const deadline = Math.floor(now() / 1000) + 1800;
const id = "claim:synthetic-engagement-817";
const claim = issueConversionClaim({
  id, subject: "supplier:synthetic-atlas", holderPublicKey: holderPub,
  eventCommitment: event, score: 880,
  validThrough: new Date((deadline + 86_400) * 1000).toISOString().slice(0, 10),
}, issuerKey);
const intent: ConversionIntent = {
  kind: "AttestConversionIntent", version: 1, chainId: 11155111,
  token, recipient: account, policyId: policy.id,
  id, contentID: claim.contentID, eventCommitment: event,
  subject: claim.subject, holderPublicKey: holderPub,
  issuerAccount, issuerPublicKey: issuerPub, expiresAt: deadline,
};
const artifacts = path.resolve(import.meta.dirname, "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts");
let presentation: PrivateConversionPresentation;
const makePorts = (): ConversionVerifierPorts => ({
  nowMs: now,
  resolvePolicy: async (policyId) => policyId === policy.id ? policy : null,
  readCredential: async () => ({
    id, contentID: claim.contentID, issuerAccount, issuerPublicKey: issuerPub,
    subject: intent.subject, holderPublicKey: holderPub,
    scope: issuerScope, active: true,
    observedAtMs: now(),
    validUntilSeconds: deadline + 86_400,
  }),
  acceptedIssuer: async (issuer, key, scope) =>
    issuer.toLowerCase() === issuerAccount && key === issuerPub && scope === issuerScope,
  isAlreadySpent: async () => false,
});

beforeAll(async () => {
  presentation = await preparePrivateConversion(claim, intent, policy, holderKey, artifacts);
}, 120_000);

describe("private claim-to-ATTEST conversion", () => {
  it("proves a hidden score and derives ONLY the trusted policy amount", async () => {
    const verified = await verifyPrivateConversion(presentation, intent, policy, makePorts(), artifacts);
    expect(verified.voucher.amount).toBe(200n * 10n ** 18n);
    expect(verified.voucher.nullifier).toBe(entitlementNullifier(event));
    expect(verified.voucher.recipient).toBe(account);
    expect(verified.voucher.proofCommitment).toBe(presentation.proof.proofCommitment);
    // Signed private score and raw credential are not part of the mint output.
    expect(JSON.stringify(verified, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("claim_score");
    expect(presentation.proof.revealedClaims.pods.credential?.entries?.claim_score).toBeUndefined();
  });

  it("signs an exact EIP-712 voucher only AFTER real GPC verification", async () => {
    const authorization = await authorizePrivateConversion(
      presentation, intent, policy, makePorts(), digest("a"), artifacts,
    );
    expect(authorization.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(authorization.voucher.palette).toBeGreaterThan(0n);
  });

  it("rejects redirected recipient, changed issuer, amount policy, and replayed claims", async () => {
    await expect(verifyPrivateConversion(
      presentation, { ...intent, recipient: token }, policy, makePorts(), artifacts,
    )).rejects.toThrow();
    await expect(verifyPrivateConversion(
      presentation, { ...intent, issuerPublicKey: holderPub }, policy, makePorts(), artifacts,
    )).rejects.toThrow();
    await expect(verifyPrivateConversion(
      presentation, intent, { ...policy, minimumScore: 990 }, makePorts(), artifacts,
    )).rejects.toThrow();
    await expect(verifyPrivateConversion(
      presentation, intent, policy,
      { ...makePorts(), isAlreadySpent: async () => true }, artifacts,
    )).rejects.toThrow(/already redeemed/);
  });

  it("rejects status failures, stale snapshots, wrong subject and untrusted issuers", async () => {
    for (const ports of [
      { ...makePorts(), readCredential: async () => null },
      { ...makePorts(), readCredential: async () => ({
        id, contentID: claim.contentID, issuerAccount, issuerPublicKey: issuerPub,
        subject: intent.subject, holderPublicKey: holderPub, scope: issuerScope,
        active: false, observedAtMs: now(), validUntilSeconds: deadline + 86_400,
      }) },
      { ...makePorts(), readCredential: async () => ({
        id, contentID: claim.contentID, issuerAccount, issuerPublicKey: issuerPub,
        subject: "another", holderPublicKey: holderPub, scope: issuerScope,
        active: true, observedAtMs: now(), validUntilSeconds: deadline + 86_400,
      }) },
      { ...makePorts(), readCredential: async () => ({
        id, contentID: claim.contentID, issuerAccount, issuerPublicKey: issuerPub,
        subject: intent.subject, holderPublicKey: holderPub, scope: issuerScope,
        active: true, observedAtMs: now() - 15_000, validUntilSeconds: deadline + 86_400,
      }) },
      { ...makePorts(), acceptedIssuer: async () => false },
      { ...makePorts(), resolvePolicy: async () => null },
      { ...makePorts(), resolvePolicy: async () => ({ ...policy, mintAmount: 900n * 10n ** 18n }) },
    ] satisfies ConversionVerifierPorts[]) {
      await expect(verifyPrivateConversion(presentation, intent, policy, ports, artifacts)).rejects.toThrow();
    }
  });

  it("rejects mismatched holder consent and altered proof transcripts", async () => {
    const wrongHolder = { ...presentation, holderConsent: claim.pod };
    await expect(verifyPrivateConversion(wrongHolder, intent, policy, makePorts(), artifacts)).rejects.toThrow();
    const wrongProof = { ...presentation, proof: { ...presentation.proof, proofCommitment: digest("0") } };
    await expect(verifyPrivateConversion(wrongProof, intent, policy, makePorts(), artifacts)).rejects.toThrow();
  });

  it("does not prove under-threshold signed scores", async () => {
    const under = issueConversionClaim({
      id: "claim:under-threshold", subject: claim.subject, holderPublicKey: holderPub,
      eventCommitment: digest("d"), score: 100,
      validThrough: new Date((deadline + 86_400)*1000).toISOString().slice(0,10),
    }, issuerKey);
    const underIntent = { ...intent, id: under.id, contentID: under.contentID, eventCommitment: under.eventCommitment };
    await expect(preparePrivateConversion(under, underIntent, policy, holderKey, artifacts)).rejects.toThrow();
  }, 120_000);
});
