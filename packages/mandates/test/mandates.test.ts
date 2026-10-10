import {describe, expect, it} from "vitest";
import {Effect} from "effect";
import {readFileSync} from "node:fs";
import {
  MANDATE_SCHEMA, APPROVAL_SCHEMA, assertMandateContext, canonicalJson, documentDigest, issueMandate,
  issueTransactionApproval, keyThumbprint, LocalStatusRegistry, parseMandate, verifyApproval, verifyPresentation
} from "../src/index.ts";
import type {AgentMandate, OperationContext, TransactionApproval, VerificationPorts} from "../src/index.ts";
const NOW = 1791655200000;
async function keys() {
  const pair = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  return {private: await crypto.subtle.exportKey("jwk", pair.privateKey), public: await crypto.subtle.exportKey("jwk", pair.publicKey)};
}
async function fixture() {
  const human = await keys(), agent = await keys(), childAgent = await keys();
  const clientId = "https://atlas.example/agent.json";
  const thumbprint = await keyThumbprint(agent.public);
  let now = NOW, mode = "active";
  const mandate: AgentMandate = {
    schema: MANDATE_SCHEMA, id: "mandate-1", issuer: "authority:alice", subject: "user:alice", tenant: "shop",
    delegate: {clientId, keyThumbprint: thumbprint}, audience: "https://shop.example/poppy",
    actions: ["orders.exchange"], constraints: {
      resources: ["order:7"], purposes: ["CustomerSupport"],
      terms: {recipient: {equals: "alice"}, replacement: {oneOf: ["medium", "large"]}},
      money: {currency: "USD", maxPerActionMinor: 7000, maxTotalMinor: 10000}
    }, issuedAt: NOW - 1000, validFrom: NOW - 1000, validUntil: NOW + 60000,
    statusRef: "status:mandate-1", mayDelegate: true, maxDelegationDepth: 2
  };
  const ports: VerificationPorts = {
    resolveKey: async (issuer, kid) => kid !== "key1" ? null : issuer === mandate.issuer ? human.public : issuer === clientId ? agent.public : null,
    authorizedIssuer: async (issuer, subject) => issuer === mandate.issuer && subject === mandate.subject,
    status: async (_ref, digest) => mode === "missing" ? null : {digest, status: mode === "revoked" ? "revoked" : "active",
      observedAt: mode === "stale" ? now - 5000 : now, validUntil: now + 5000},
    now: () => now, maxStatusAgeMs: 5000
  };
  const context: OperationContext = {subject: mandate.subject, tenant: mandate.tenant, actor: mandate.delegate,
    audience: mandate.audience, action: "orders.exchange", resource: "order:7", purpose: "CustomerSupport",
    terms: {recipient: "alice", replacement: "medium"}, money: {currency: "USD", amountMinor: 7000}};
  const token = await Effect.runPromise(issueMandate(mandate, "key1", human.private));
  return {human, agent, childAgent, mandate, ports, token, context, advance: (t: number) => {now = t;}, status: (v: string) => {mode = v;}};
}
describe("signed agent mandates", () => {
  it("pins status references to one immutable document and never resurrects revocation on an issuance retry", async () => {
    const f = await fixture(), registry = new LocalStatusRegistry();
    const digest = await Effect.runPromise(registry.register(f.mandate));
    const ports = {...f.ports, status: (ref: string, hash: string) => Effect.runPromise(registry.read(ref, hash, NOW))};
    await expect(Effect.runPromise(verifyPresentation([f.token], ports))).resolves.toBeDefined();
    expect(await Effect.runPromise(registry.read(f.mandate.statusRef, "a".repeat(64), NOW))).toBeNull();
    await expect(Effect.runPromise(registry.register({...f.mandate, subject: "user:bob"}))).rejects.toThrow();
    await Effect.runPromise(registry.revoke(f.mandate.statusRef));
    expect(await Effect.runPromise(registry.register(f.mandate))).toBe(digest);
    expect((await Effect.runPromise(registry.read(f.mandate.statusRef, digest, NOW)))?.status).toBe("revoked");
    await expect(Effect.runPromise(verifyPresentation([f.token], ports))).rejects.toThrow();
  });
  it("consumes the same signed interoperability vector as Gatekeeper", async () => {
    const v = JSON.parse(readFileSync(new URL("../fixtures/mandate-v1.json", import.meta.url), "utf8"));
    expect(v.issuerPublicKey.d).toBeUndefined(); expect(v.agentPublicKey.d).toBeUndefined();
    const chain = await Effect.runPromise(verifyPresentation([v.token], {
      resolveKey: async (issuer, kid) => issuer === v.mandate.issuer && kid === v.keyId ? v.issuerPublicKey : null,
      authorizedIssuer: async (issuer, subject) => issuer === v.mandate.issuer && subject === v.mandate.subject,
      status: async (_ref, digest) => ({digest, status: "active", observedAt: v.now, validUntil: v.now + 5000}),
      now: () => v.now, maxStatusAgeMs: 5000
    }));
    expect(chain.digests).toEqual([v.expectedDigest]);
    expect(await keyThumbprint(v.agentPublicKey)).toBe(v.mandate.delegate.keyThumbprint);
  });
  it("verifies real ES256 credentials and binds the agent key and full operation", async () => {
    const f = await fixture();
    const chain = await Effect.runPromise(verifyPresentation([f.token], f.ports));
    expect(() => assertMandateContext(chain, f.context, NOW)).not.toThrow();
    expect(chain.expiresAt).toBe(NOW + 5000);
    expect(chain.digests).toEqual([await documentDigest(f.mandate)]);
  });
  it.each(["subject", "tenant", "audience", "action", "resource", "purpose"] as const)("rejects a different %s", async key => {
    const f = await fixture(), chain = await Effect.runPromise(verifyPresentation([f.token], f.ports));
    expect(() => assertMandateContext(chain, {...f.context, [key]: key === "audience" ? "https://evil.example" : "other"}, NOW)).toThrow();
  });
  it("requires the authenticated holder key, not just a client ID", async () => {
    const f = await fixture(), chain = await Effect.runPromise(verifyPresentation([f.token], f.ports));
    expect(() => assertMandateContext(chain, {...f.context, actor: {...f.context.actor, keyThumbprint: "a".repeat(43)}}, NOW)).toThrow();
  });
  it.each(["missing", "revoked", "stale"])("fails closed for %s status", async mode => {
    const f = await fixture(); f.status(mode);
    await expect(Effect.runPromise(verifyPresentation([f.token], f.ports))).rejects.toThrow();
  });
  it("rejects wrong status commitments, keys, issuers, and malformed signatures", async () => {
    const f = await fixture();
    for (const ports of [
      {...f.ports, status: async () => ({digest: "0".repeat(64), status: "active" as const, observedAt: NOW, validUntil: NOW + 1000})},
      {...f.ports, resolveKey: async () => f.agent.public},
      {...f.ports, authorizedIssuer: async () => false}
    ]) await expect(Effect.runPromise(verifyPresentation([f.token], ports))).rejects.toThrow();
    const changed = f.token.split(".");
    changed[2] = (changed[2]!.startsWith("A") ? "B" : "A") + changed[2]!.slice(1);
    await expect(Effect.runPromise(verifyPresentation([changed.join(".")], f.ports))).rejects.toThrow();
  });
  it("rejects expiry, not-yet-valid mandates, and stale verification snapshots", async () => {
    const f = await fixture(), chain = await Effect.runPromise(verifyPresentation([f.token], f.ports));
    expect(() => assertMandateContext(chain, f.context, NOW + 5000)).toThrow();
    f.advance(NOW + 60000); await expect(Effect.runPromise(verifyPresentation([f.token], f.ports))).rejects.toThrow();
    f.advance(NOW - 2000); await expect(Effect.runPromise(verifyPresentation([f.token], f.ports))).rejects.toThrow();
  });
  it("checks integer minor units, currency and every business term", async () => {
    const f = await fixture(), chain = await Effect.runPromise(verifyPresentation([f.token], f.ports));
    for (const context of [
      {...f.context, money: {currency: "USD", amountMinor: 7001}},
      {...f.context, money: {currency: "EUR", amountMinor: 7000}},
      {...f.context, money: {currency: "USD", amountMinor: 0.5}},
      {...f.context, terms: {...f.context.terms, recipient: "mallory"}},
      {...f.context, terms: {...f.context.terms, hidden_fee: 50}},
      {...f.context, terms: {replacement: "medium"}}
    ]) expect(() => assertMandateContext(chain, context, NOW)).toThrow();
    const free = {...f.mandate, constraints: {resources: ["order:7"], purposes: ["CustomerSupport"], terms: f.mandate.constraints.terms}};
    const freeToken = await Effect.runPromise(issueMandate(free, "key1", f.human.private));
    const freeChain = await Effect.runPromise(verifyPresentation([freeToken], f.ports));
    expect(() => assertMandateContext(freeChain, f.context, NOW)).toThrow();
  });
  it("permits a strictly narrower, key-linked subdelegation", async () => {
    const f = await fixture();
    const child: AgentMandate = {...f.mandate, id: "child-1", issuer: f.mandate.delegate.clientId,
      delegate: {clientId: "https://specialist.example/agent.json", keyThumbprint: await keyThumbprint(f.childAgent.public)},
      parentDigest: await documentDigest(f.mandate), mayDelegate: false, maxDelegationDepth: 0,
      constraints: {...f.mandate.constraints, terms: {recipient: {equals: "alice"}, replacement: {equals: "medium"}},
        money: {currency: "USD", maxPerActionMinor: 7000, maxTotalMinor: 7000}}};
    const childToken = await Effect.runPromise(issueMandate(child, "key1", f.agent.private));
    const chain = await Effect.runPromise(verifyPresentation([f.token, childToken], f.ports));
    expect(() => assertMandateContext(chain, {...f.context, actor: child.delegate}, NOW)).not.toThrow();
    await expect(Effect.runPromise(verifyPresentation([childToken], f.ports))).rejects.toThrow();
    await expect(Effect.runPromise(verifyPresentation([f.token, f.token], f.ports))).rejects.toThrow();
    for (const modified of [
      {...child, actions: ["orders.delete"]},
      {...child, audience: "https://other.example"},
      {...child, validUntil: f.mandate.validUntil + 1},
      {...child, maxDelegationDepth: 2, mayDelegate: true},
      {...child, constraints: {...child.constraints, terms: {recipient: {any: true as const}, replacement: {equals: "medium"}}}},
      {...child, parentDigest: "a".repeat(64)}
    ]) {
      const token = await Effect.runPromise(issueMandate(modified, "key1", f.agent.private));
      await expect(Effect.runPromise(verifyPresentation([f.token, token], f.ports))).rejects.toThrow();
    }
  });
  it("requires the exact parent holder key and permission to subdelegate", async () => {
    const f = await fixture();
    const child = {...f.mandate, id: "child", issuer: f.mandate.delegate.clientId, parentDigest: await documentDigest(f.mandate),
      mayDelegate: false, maxDelegationDepth: 0};
    const forged = await Effect.runPromise(issueMandate(child, "key1", f.childAgent.private));
    await expect(Effect.runPromise(verifyPresentation([f.token, forged], {...f.ports, resolveKey: async issuer =>
      issuer === f.mandate.issuer ? f.human.public : f.childAgent.public}))).rejects.toThrow();
    const terminal = {...f.mandate, mayDelegate: false, maxDelegationDepth: 0};
    const terminalToken = await Effect.runPromise(issueMandate(terminal, "key1", f.human.private));
    const childToken = await Effect.runPromise(issueMandate({...child, parentDigest: await documentDigest(terminal)}, "key1", f.agent.private));
    await expect(Effect.runPromise(verifyPresentation([terminalToken, childToken], f.ports))).rejects.toThrow();
  });
  it("binds user approvals to the mandate, operation, revision and commitment", async () => {
    const f = await fixture();
    const expected = {context: f.context, mandateDigest: await documentDigest(f.mandate),
      operationId: "exchange-1", revision: 1, operationDigest: "a".repeat(64)};
    const approval: TransactionApproval = {schema: APPROVAL_SCHEMA, id: "approval-1", issuer: f.mandate.issuer,
      subject: f.mandate.subject, tenant: f.mandate.tenant, audience: f.mandate.audience, delegate: f.mandate.delegate,
      mandateDigest: expected.mandateDigest, operationId: expected.operationId, revision: 1,
      operationDigest: expected.operationDigest, issuedAt: NOW, validUntil: NOW + 30000, statusRef: "status:approval-1"};
    const token = await Effect.runPromise(issueTransactionApproval(approval, "key1", f.human.private));
    expect((await Effect.runPromise(verifyApproval(token, expected, f.ports))).id).toBe(approval.id);
    for (const next of [
      {...expected, revision: 2}, {...expected, operationId: "exchange-2"},
      {...expected, operationDigest: "b".repeat(64)}, {...expected, mandateDigest: "b".repeat(64)}
    ]) await expect(Effect.runPromise(verifyApproval(token, next, f.ports))).rejects.toThrow();
    await expect(Effect.runPromise(verifyApproval(f.token, expected, f.ports))).rejects.toThrow();
    await expect(Effect.runPromise(verifyApproval(token, expected, {...f.ports,
      authorizedIssuer: async (_issuer, _subject, kind) => kind === "mandate"}))).rejects.toThrow();
  });
  it("keeps commitments stable across independent signatures of the same grant", async () => {
    const f = await fixture(), token2 = await Effect.runPromise(issueMandate(f.mandate, "key1", f.human.private));
    expect((await Effect.runPromise(verifyPresentation([token2], f.ports))).digests)
      .toEqual((await Effect.runPromise(verifyPresentation([f.token], f.ports))).digests);
  });
  it("rejects unsupported constraints, wildcard scopes, non-JSON inputs and excessive depth", async () => {
    const f = await fixture();
    for (const value of [
      {...f.mandate, schema: "future/v2"}, {...f.mandate, actions: ["orders.*"]},
      {...f.mandate, constraints: {...f.mandate.constraints, ignoredCondition: true}},
      {...f.mandate, maxDelegationDepth: 9}, {...f.mandate, actions: ["orders.exchange", "orders.exchange"]}
    ]) expect(() => parseMandate(value)).toThrow();
    for (const value of [{a: undefined}, [undefined], new Date(), {value: NaN}, {value: -0},
      {get secret() {throw new Error("Getter must never execute");}}, JSON.parse('{"__proto__":{}}')]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    expect(canonicalJson({"2": "second", "10": "tenth"})).toBe('{"10":"tenth","2":"second"}');
  });
});
