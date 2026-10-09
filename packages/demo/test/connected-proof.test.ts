import { it, expect } from "vitest";
import path from "node:path";
import {
  connectedCredentialSchema,
  issueConnectedCredential,
  prepareConnectedPresentation,
  verifyConnectedPresentation,
  signingPublicKey,
  type ConnectedRequest,
} from "../src/connected-proof";
const artifacts = path.resolve(
  import.meta.dirname,
  "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
);
it("connected proofs bind exact POD content, holder, request, issuer and registry", async () => {
  const holder = "11".repeat(32),
    issuer = "22".repeat(32),
    registry = "0x1111111111111111111111111111111111111111",
    audience = "0x2222222222222222222222222222222222222222";
  const credential = await issueConnectedCredential(
    {
      id: crypto.randomUUID(),
      chainId: 11155111,
      registry,
      issuerAccount: audience,
      subject: "holder:alice",
      holderPublicKey: signingPublicKey(holder),
      validThrough: "2030-12-31",
    },
    40,
    issuer,
  );
  const request: ConnectedRequest = {
    kind: "ConnectedTrainingRequest",
    version: 1,
    id: crypto.randomUUID(),
    chainId: 11155111,
    registry,
    audience,
    issuerAccount: audience,
    credentialId: credential.id,
    contentID: credential.contentID,
    subject: credential.subject,
    holderPublicKey: credential.holderPublicKey,
    issuerPublicKey: credential.issuerPublicKey,
    minimumHours: 24,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  expect(
    connectedCredentialSchema.safeParse({ ...credential, contentID: "1" })
      .success,
  ).toBe(false);
  expect(
    connectedCredentialSchema.safeParse({
      ...credential,
      subject: "holder:bob",
    }).success,
  ).toBe(false);
  expect(
    connectedCredentialSchema.safeParse({
      ...credential,
      validThrough: "2031-12-31",
    }).success,
  ).toBe(false);
  const substitute = await issueConnectedCredential(
    {
      id: credential.id,
      chainId: 11155111,
      registry,
      issuerAccount: audience,
      subject: credential.subject,
      holderPublicKey: credential.holderPublicKey,
      validThrough: credential.validThrough,
    },
    80,
    issuer,
  );
  expect(
    connectedCredentialSchema.safeParse({ ...credential, pod: substitute.pod })
      .success,
  ).toBe(false);
  await expect(
    prepareConnectedPresentation(substitute, request, holder, artifacts),
  ).rejects.toThrow();
  const proof = await prepareConnectedPresentation(
    credential,
    request,
    holder,
    artifacts,
  );
  expect(
    await verifyConnectedPresentation(proof, request, audience, artifacts),
  ).toBe(true);
  expect(
    await verifyConnectedPresentation(
      proof,
      { ...request, contentID: "1" },
      audience,
      artifacts,
    ),
  ).toBe(false);
  expect(
    await verifyConnectedPresentation(
      proof,
      { ...request, minimumHours: 80 },
      audience,
      artifacts,
    ),
  ).toBe(false);
  expect(
    await verifyConnectedPresentation(proof, request, registry, artifacts),
  ).toBe(false);
  await expect(
    prepareConnectedPresentation(
      credential,
      { ...request, registry: audience },
      holder,
      artifacts,
    ),
  ).rejects.toThrow();
  await expect(
    prepareConnectedPresentation(credential, request, issuer, artifacts),
  ).rejects.toThrow();
}, 120000);
