import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { POD } from "@pcd/pod";
import { canonicalJson } from "@attest/core";
import path from "node:path";
import {
  createWorkspace,
  requestDraft,
  runWorkspaceCommand,
  parseWorkspaceDocument,
  documentYaml,
  inspectWorkspace,
  type Workspace,
  type Actor,
  type WorkspaceCommand,
} from "../src/workspace";
const now = "2026-10-09T12:00:00.000Z";
const artifacts = path.resolve(
  import.meta.dirname,
  "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
);
const run = (s: Workspace, a: Actor, c: WorkspaceCommand, at = now) =>
  Effect.runPromise(runWorkspaceCommand(s, a, c, { now: at, artifacts }));
async function ready(
  mode: "private-proof" | "disclosed-records" = "disclosed-records",
) {
  let s = createWorkspace(now);
  s = await run(s, "board", { type: "issue", approved: true });
  s = await run(s, "training", { type: "issue", approved: true });
  s = await run(s, "hospital", {
    type: "request.create",
    document: { ...requestDraft(now), disclosure: mode },
  });
  return s;
}
async function sent() {
  let s = await ready();
  s = await run(s, "jordan", { type: "prepare" });
  return run(s, "jordan", { type: "send", approved: true });
}
describe("wallet workspace", () => {
  it("round trips readable documents and rejects unknown fields, duplicate keys and aliases", () => {
    const r = requestDraft(now);
    expect(parseWorkspaceDocument(documentYaml(r))).toEqual(r);
    expect(() =>
      parseWorkspaceDocument(documentYaml({ ...r, privateKey: "secret" })),
    ).toThrow();
    expect(() =>
      parseWorkspaceDocument("kind: Wallet\nkind: Wallet"),
    ).toThrow();
    expect(() => parseWorkspaceDocument("x: &x [a]\ny: *x")).toThrow();
  });
  it("enforces issuer, holder, and explicit approval boundaries", async () => {
    const s = createWorkspace(now);
    await expect(
      run(s, "jordan", { type: "issue", approved: true }),
    ).rejects.toThrow();
    await expect(
      run(s, "board", { type: "issue", approved: false }),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        runWorkspaceCommand(
          s,
          "board",
          { type: "issue", approved: true },
          { principal: "agent" },
        ),
      ),
    ).rejects.toThrow();
    const t = await ready();
    await expect(
      run(t, "training", {
        type: "revoke",
        credentialId: t.credentials[0]!.id,
        approved: true,
      }),
    ).rejects.toThrow();
    expect(s.credentials).toHaveLength(0);
  });
  it("requires both issuers and sufficient current evidence", async () => {
    let s = await ready();
    s.credentials = s.credentials.filter((c) => c.issuer === "board");
    await expect(run(s, "jordan", { type: "prepare" })).rejects.toThrow(
      "Missing evidence",
    );
    s = await ready();
    s.sources.trainingHours = 1;
    s = await run(s, "training", { type: "issue", approved: true });
    await expect(run(s, "jordan", { type: "prepare" })).rejects.toThrow(
      "does not meet",
    );
  });
  it("approves, then observes signed revocation without erasing the earlier decision", async () => {
    let s = await sent();
    s = await run(s, "hospital", { type: "verify" });
    expect(s.decisions.at(-1)?.result).toBe("approved");
    s = await run(s, "board", {
      type: "revoke",
      credentialId: s.credentials[0]!.id,
      approved: true,
    });
    s = await run(s, "board", { type: "status.refresh" });
    s = await run(s, "hospital", { type: "verify" });
    expect(s.decisions.map((d) => d.result)).toEqual(["approved", "rejected"]);
  });
  it("reports pending for outage and stale status instead of approving", async () => {
    let s = await sent();
    const stale = await run(
      s,
      "hospital",
      { type: "verify" },
      "2026-10-09T14:00:00.000Z",
    );
    expect(stale.decisions.at(-1)?.result).toBe("pending");
    s = await run(s, "hospital", {
      type: "status.availability",
      available: false,
    });
    s = await run(s, "hospital", { type: "verify" });
    expect(s.decisions.at(-1)?.result).toBe("pending");
  });
  it("rejects replay, request substitution, expiry, and subject mismatch", async () => {
    let s = await sent();
    s.prepared = s.presentations[0]!;
    await expect(
      run(s, "jordan", { type: "send", approved: true }),
    ).rejects.toThrow("replay");
    s.request!.requirements.minimumTrainingHours = 1;
    await expect(run(s, "hospital", { type: "verify" })).rejects.toThrow(
      "unauthenticated",
    );
    s = await ready();
    await expect(
      run(s, "jordan", { type: "prepare" }, "2026-10-11T12:00:00.000Z"),
    ).rejects.toThrow("not current");
    const draft = { ...requestDraft(now), subject: "someone-else" };
    s = await run(s, "hospital", { type: "request.create", document: draft });
    await expect(run(s, "jordan", { type: "prepare" })).rejects.toThrow(
      "different subject",
    );
  });
  it("rejects duplicate evidence even with a valid holder signature", async () => {
    let s = await sent();
    const p = s.presentations[0]!;
    p.items[1] = p.items[0]!;
    const { signature: _, ...unsigned } = p;
    p.signature = POD.sign(
      { document: { type: "string", value: canonicalJson(unsigned) } },
      "11".repeat(32),
    ).toJSON();
    s = await run(s, "hospital", { type: "verify" });
    expect(s.decisions.at(-1)?.result).toBe("rejected");
  });
  it("cannot turn a self-issued foreign jurisdiction into recognized authority", async () => {
    let s = await ready();
    s.sources.jurisdiction = "OH";
    s = await run(s, "board", { type: "issue", approved: true });
    const r = requestDraft(now);
    r.disclosure = "disclosed-records";
    r.requirements.jurisdiction = "OH";
    s = await run(s, "hospital", { type: "request.create", document: r });
    s = await run(s, "jordan", { type: "prepare" });
    s = await run(s, "jordan", { type: "send", approved: true });
    s = await run(s, "hospital", { type: "verify" });
    expect(
      s.decisions.at(-1)?.checks.find((c) => c.name === "Recognized")?.result,
    ).toBe("fail");
  });
  it("rejects credentials with a substituted subject, unknown signer, or expired validity", async () => {
    for (const attack of ["subject", "signer", "expiry"]) {
      const s = await ready();
      const c = s.credentials.find((c) => c.issuer === "board")!;
      const entries = { ...POD.fromJSON(c.pod).content.asEntries() };
      if (attack === "subject")
        entries.subject = { type: "string", value: "clinician:another" };
      if (attack === "expiry")
        entries.claim_validUntil = { type: "int", value: 1n };
      c.pod = POD.sign(
        entries,
        (attack === "signer" ? "55" : "22").repeat(32),
      ).toJSON();
      await expect(run(s, "jordan", { type: "prepare" })).rejects.toThrow(
        "does not meet",
      );
    }
  });
  it("never elevates permissions through wallet or template documents", async () => {
    const s = createWorkspace(now);
    const wallet = { ...s.wallets[0]!, roles: ["issuer"] };
    await expect(
      run(s, "jordan", { type: "wallet.update", document: wallet }),
    ).rejects.toThrow();
    await expect(
      run(s, "board", {
        type: "template.apply",
        document: {
          apiVersion: "attest.dev/v1alpha1",
          kind: "IssuanceTemplate",
          issuer: "training",
          subject: "clinician:jordan-lee",
          schema: "attest.workspace.training.v1",
          claims: { hours: 999, validUntil: "2027-10-09T00:00:00.000Z" },
        },
      }),
    ).rejects.toThrow("mismatch");
  });
  it("produces and verifies two real private proofs, keeping source records out of the verifier projection", async () => {
    let s = await ready("private-proof");
    s = await run(s, "jordan", { type: "prepare" });
    expect(s.presentations).toHaveLength(0);
    expect(s.prepared?.items.every((i) => i.proof && !i.credential)).toBe(true);
    await expect(
      run(s, "jordan", { type: "send", approved: false }),
    ).rejects.toThrow();
    s = await run(s, "jordan", { type: "send", approved: true });
    s = await run(s, "hospital", { type: "verify" });
    expect(s.decisions.at(-1)?.result).toBe("approved");
    expect(inspectWorkspace(s, "hospital")).not.toHaveProperty("credentials");
    s.presentations[0]!.items[0]!.proof = {
      ...s.presentations[0]!.items[0]!.proof!,
      proofCommitment: "tampered",
    };
    s = await run(s, "hospital", { type: "verify" });
    expect(s.decisions.at(-1)?.result).toBe("rejected");
  }, 120000);
});
