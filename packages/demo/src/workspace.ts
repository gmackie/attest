import { POD, deriveSignerPublicKey } from "@pcd/pod";
import { canonicalJson, commitValue } from "@attest/core";
import {
  issueCriteriaPod,
  proveCriteria,
  verifyCriteria,
  type CriteriaRequest,
} from "@attest/proofs";
import type { GpcProofEnvelope } from "@attest/proofs";
import { Effect } from "effect";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

export const WORKSPACE_VERSION = "attest.dev/v1alpha1";
export const actors = ["jordan", "board", "training", "hospital"] as const;
export type Actor = (typeof actors)[number];
export const actorNames: Record<Actor, string> = {
  jordan: "Jordan Lee",
  board: "Alder Nursing Board",
  training: "Pine Training Institute",
  hospital: "Willow Creek Hospital",
};
export type Source = "board" | "training";
const key = (actor: Actor) =>
  ({ jordan: "11", board: "22", training: "33", hospital: "44" })[actor].repeat(
    32,
  );
export const publicKey = (actor: Actor) => deriveSignerPublicKey(key(actor));
const date = z.string().datetime();
const id = z.string().min(1).max(200);
const subject = "clinician:jordan-lee";
const walletSchema = z
  .object({
    apiVersion: z.literal(WORKSPACE_VERSION),
    kind: z.literal("Wallet"),
    id: z.enum(actors),
    name: z.string().min(1).max(100),
    roles: z.array(z.enum(["holder", "issuer", "verifier"])).min(1),
    key: z
      .object({ provider: z.literal("demo-keystore"), reference: id })
      .strict(),
    agentPolicy: z
      .object({
        allow: z.array(z.enum(["inspect", "evaluate", "prepare"])),
        approvalRequired: z.array(z.enum(["issue", "send", "revoke"])),
      })
      .strict(),
  })
  .strict();
export const requestSchema = z
  .object({
    apiVersion: z.literal(WORKSPACE_VERSION),
    kind: z.literal("PresentationRequest"),
    id,
    verifier: z.literal("hospital"),
    subject: id,
    purpose: z.string().min(1).max(500),
    challenge: id,
    createdAt: date,
    expiresAt: date,
    disclosure: z.enum(["private-proof", "disclosed-records"]),
    requirements: z
      .object({
        jurisdiction: z.enum(["MI", "OH", "NY"]),
        minimumTrainingHours: z.number().int().min(1).max(1000),
      })
      .strict(),
    statusMaxAgeSeconds: z.number().int().min(1).max(86400),
  })
  .strict()
  .refine(
    (r) => Date.parse(r.expiresAt) > Date.parse(r.createdAt),
    "Expiry must follow creation",
  );
export type WalletDocument = z.infer<typeof walletSchema>;
export type RequestDocument = z.infer<typeof requestSchema>;
const sourceSchema = z
  .object({
    licenseActive: z.boolean(),
    jurisdiction: z.enum(["MI", "OH", "NY"]),
    licenseValidUntil: date,
    trainingHours: z.number().int().min(0).max(10000),
    trainingValidUntil: date,
  })
  .strict();
export type SourceRecords = z.infer<typeof sourceSchema>;
const signedPod = z.custom<ReturnType<POD["toJSON"]>>((value) => {
  try {
    return POD.fromJSON(value as ReturnType<POD["toJSON"]>).verifySignature();
  } catch {
    return false;
  }
}, "Invalid signed POD");
const credentialSchema = z
  .object({
    id,
    issuer: z.enum(["board", "training"]),
    subject: id,
    issuedAt: date,
    pod: signedPod,
  })
  .strict();
export type WorkspaceCredential = z.infer<typeof credentialSchema>;
const statusSchema = z
  .object({
    credentialId: id,
    issuer: z.enum(["board", "training"]),
    state: z.enum(["active", "revoked"]),
    checkedAt: date,
    signature: signedPod,
  })
  .strict();
const itemSchema = z
  .object({
    credentialId: id,
    issuer: z.enum(["board", "training"]),
    proof: z.custom<GpcProofEnvelope>().optional(),
    credential: signedPod.optional(),
  })
  .strict();
const presentationSchema = z
  .object({
    id,
    requestDigest: id,
    requestId: id,
    holder: z.literal("jordan"),
    audience: z.literal("hospital"),
    createdAt: date,
    items: z.array(itemSchema).length(2),
    signature: signedPod,
  })
  .strict();
export type WorkspacePresentation = z.infer<typeof presentationSchema>;
export type Check = {
  name: "Authentic" | "Recognized" | "Current" | "Meets your request";
  result: "pass" | "fail" | "pending";
  detail: string;
};
export type Decision = {
  apiVersion: typeof WORKSPACE_VERSION;
  kind: "DecisionRecord";
  requestId: string;
  presentationId: string;
  checkedAt: string;
  result: "approved" | "rejected" | "pending";
  checks: Check[];
};
const decisionSchema = z
  .object({
    apiVersion: z.literal(WORKSPACE_VERSION),
    kind: z.literal("DecisionRecord"),
    requestId: id,
    presentationId: id,
    checkedAt: date,
    result: z.enum(["approved", "rejected", "pending"]),
    checks: z.array(
      z
        .object({
          name: z.enum([
            "Authentic",
            "Recognized",
            "Current",
            "Meets your request",
          ]),
          result: z.enum(["pass", "fail", "pending"]),
          detail: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export const workspaceSchema = z
  .object({
    version: z.literal(1),
    wallets: z.array(walletSchema).length(4),
    sources: sourceSchema,
    credentials: z.array(credentialSchema),
    statuses: z.array(statusSchema),
    statusAvailable: z.boolean(),
    request: requestSchema.nullable(),
    requestSignature: signedPod.nullable(),
    prepared: presentationSchema.nullable(),
    presentations: z.array(presentationSchema),
    decisions: z.array(decisionSchema),
    history: z.array(
      z
        .object({
          at: date,
          actor: z.enum(actors),
          action: z.string(),
          detail: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type Workspace = z.infer<typeof workspaceSchema>;
const templateSchema = z
  .object({
    apiVersion: z.literal(WORKSPACE_VERSION),
    kind: z.literal("IssuanceTemplate"),
    issuer: z.enum(["board", "training"]),
    subject: z.literal(subject),
    schema: id,
    claims: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  })
  .strict();
const trustSchema = z
  .object({
    apiVersion: z.literal(WORKSPACE_VERSION),
    kind: z.literal("TrustProfile"),
    id: z.literal("clinical-placement-v1"),
    issuers: z.array(
      z
        .object({
          id: z.enum(["board", "training"]),
          publicKey: id,
          schema: id,
          jurisdiction: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export const trustProfile = {
  apiVersion: WORKSPACE_VERSION,
  kind: "TrustProfile",
  id: "clinical-placement-v1",
  issuers: [
    {
      id: "board",
      publicKey: publicKey("board"),
      schema: "attest.workspace.board.v1",
      jurisdiction: "MI",
    },
    {
      id: "training",
      publicKey: publicKey("training"),
      schema: "attest.workspace.training.v1",
      jurisdiction: "training-only",
    },
  ],
};
export function issuanceTemplate(state: Workspace, issuer: Source) {
  return {
    apiVersion: WORKSPACE_VERSION,
    kind: "IssuanceTemplate",
    issuer,
    subject,
    schema: `attest.workspace.${issuer}.v1`,
    claims:
      issuer === "board"
        ? {
            active: state.sources.licenseActive,
            jurisdiction: state.sources.jurisdiction,
            validUntil: state.sources.licenseValidUntil,
          }
        : {
            hours: state.sources.trainingHours,
            validUntil: state.sources.trainingValidUntil,
          },
  };
}
export const documentSchema = z.union([
  walletSchema,
  requestSchema,
  templateSchema,
  trustSchema,
  decisionSchema,
]);
export function parseWorkspaceDocument(text: string) {
  if (text.length > 100_000) throw new Error("Document exceeds 100 KB");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  return documentSchema.parse(doc.toJS({ maxAliasCount: 0 }));
}
export const documentYaml = (value: unknown) => stringify(value);
export const workspaceDocumentJsonSchema = z.toJSONSchema(documentSchema);
export function createWorkspace(now = new Date().toISOString()): Workspace {
  const expires = new Date(Date.parse(now) + 365 * 86400000).toISOString();
  return {
    version: 1,
    wallets: actors.map((actor) => ({
      apiVersion: WORKSPACE_VERSION,
      kind: "Wallet",
      id: actor,
      name: actorNames[actor],
      roles:
        actor === "jordan"
          ? ["holder"]
          : actor === "hospital"
            ? ["holder", "verifier"]
            : ["holder", "issuer"],
      key: { provider: "demo-keystore", reference: `demo:${actor}:signing` },
      agentPolicy: {
        allow: ["inspect", "evaluate", "prepare"],
        approvalRequired: ["issue", "send", "revoke"],
      },
    })),
    sources: {
      licenseActive: true,
      jurisdiction: "MI",
      licenseValidUntil: expires,
      trainingHours: 36,
      trainingValidUntil: expires,
    },
    credentials: [],
    statuses: [],
    statusAvailable: true,
    request: null,
    requestSignature: null,
    prepared: null,
    presentations: [],
    decisions: [],
    history: [],
  };
}
export function requestDraft(now = new Date().toISOString()): RequestDocument {
  return {
    apiVersion: WORKSPACE_VERSION,
    kind: "PresentationRequest",
    id: `placement-${crypto.randomUUID()}`,
    verifier: "hospital",
    subject,
    purpose: "Nursing placement at Willow Creek Hospital",
    challenge: crypto.randomUUID(),
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + 86400000).toISOString(),
    disclosure: "private-proof",
    requirements: { jurisdiction: "MI", minimumTrainingHours: 24 },
    statusMaxAgeSeconds: 3600,
  };
}
function sign(value: unknown, actor: Actor) {
  return POD.sign(
    { document: { type: "string", value: canonicalJson(value) } },
    key(actor),
  ).toJSON();
}
function authentic(
  value: unknown,
  signature: ReturnType<POD["toJSON"]>,
  actor: Actor,
) {
  try {
    const pod = POD.fromJSON(signature);
    return (
      pod.verifySignature() &&
      pod.signerPublicKey === publicKey(actor) &&
      pod.content.asEntries().document?.value === canonicalJson(value)
    );
  } catch {
    return false;
  }
}
function statusValue(status: Workspace["statuses"][number]) {
  const { signature: _, ...value } = status;
  return value;
}
function statusFor(
  credential: WorkspaceCredential,
  state: "active" | "revoked",
  now: string,
): Workspace["statuses"][number] {
  const value = {
    credentialId: credential.id,
    issuer: credential.issuer,
    state,
    checkedAt: now,
  };
  return { ...value, signature: sign(value, credential.issuer) };
}
function requirements(
  request: RequestDocument,
  issuer: Source,
  credentialId: string,
  challenge: string,
): CriteriaRequest {
  return {
    schema: `attest.workspace.${issuer}.v1`,
    subject: request.subject,
    holderPublicKey: publicKey("jordan"),
    issuerPublicKey: publicKey(issuer),
    challenge,
    criteria: [
      {
        field: "credentialId",
        operator: "eq",
        value: credentialId,
        kind: "text",
      },
      {
        field: "validUntil",
        operator: "gte",
        value: request.expiresAt.slice(0, 10),
        kind: "date",
      },
      ...(issuer === "board"
        ? [
            {
              field: "licenseScope",
              operator: "eq" as const,
              value: `active:${request.requirements.jurisdiction}`,
              kind: "text" as const,
            },
          ]
        : [
            {
              field: "hours",
              operator: "gte" as const,
              value: request.requirements.minimumTrainingHours,
              kind: "number" as const,
            },
          ]),
    ],
  };
}
function checkCredential(
  podJson: ReturnType<POD["toJSON"]>,
  req: CriteriaRequest,
): boolean {
  try {
    const pod = POD.fromJSON(podJson),
      fields = pod.content.asEntries();
    if (
      !pod.verifySignature() ||
      pod.signerPublicKey !== req.issuerPublicKey ||
      fields.schema?.value !== req.schema ||
      fields.subject?.value !== req.subject ||
      fields.holder?.value !== req.holderPublicKey
    )
      return false;
    return req.criteria.every((c) => {
      const field = fields[`claim_${c.field}`];
      const expected =
        c.kind === "date"
          ? BigInt(Date.parse(c.value as string) / 86400000)
          : c.kind === "number"
            ? BigInt(Number(c.value) * 1000)
            : c.value;
      if (
        !field ||
        field.value === null ||
        typeof field.value !== typeof expected
      )
        return false;
      return c.operator === "eq"
        ? field.value === expected
        : c.operator === "gte"
          ? field.value >= expected
          : field.value <= expected;
    });
  } catch {
    return false;
  }
}
export function disclosurePreview(request: RequestDocument) {
  return {
    recipient: actorNames.hospital,
    purpose: request.purpose,
    mode: request.disclosure,
    visible:
      request.disclosure === "private-proof"
        ? [
            request.subject,
            "Holder public key and accepted issuer keys",
            "Credential IDs (used for status lookup)",
            `Active license in ${request.requirements.jurisdiction}`,
            `Training ≥ ${request.requirements.minimumTrainingHours} hours`,
            `Validity through ${request.expiresAt.slice(0, 10)}`,
            "Request, challenge, proof metadata, and holder signature",
          ]
        : [
            "Complete signed license and training records",
            "Exact training hours and validity dates",
            "Subject, holder and issuer keys, credential IDs",
            "Request binding and holder signature",
          ],
    hidden:
      request.disclosure === "private-proof"
        ? [
            "Exact training hours",
            "Exact credential expiry dates",
            "Original credential signatures",
            "Private signing keys",
          ]
        : ["Private signing keys"],
    note: "Identifiers can correlate presentations. Private proofs expose required equality values and thresholds. No raw records go on-chain.",
  };
}
export type WorkspaceCommand =
  | { type: "sources.update"; records: SourceRecords }
  | { type: "wallet.update"; document: unknown }
  | { type: "template.apply"; document: unknown }
  | { type: "issue"; approved: boolean }
  | { type: "request.create"; document: unknown }
  | { type: "prepare" }
  | { type: "send"; approved: boolean }
  | { type: "verify" }
  | { type: "revoke"; credentialId: string; approved: boolean }
  | { type: "status.refresh" }
  | { type: "status.availability"; available: boolean };
export class WorkspaceError extends Error {
  readonly _tag = "WorkspaceError";
}
function requireActor(actor: Actor, allowed: readonly Actor[]) {
  if (!allowed.includes(actor))
    throw new Error("This wallet is not authorized for that operation");
}
function activeRequest(state: Workspace, now: string): RequestDocument {
  const r = state.request;
  if (
    !r ||
    !state.requestSignature ||
    !authentic(r, state.requestSignature, "hospital")
  )
    throw new Error("Missing or unauthenticated hospital request");
  if (
    Date.parse(r.createdAt) > Date.parse(now) ||
    Date.parse(r.expiresAt) <= Date.parse(now)
  )
    throw new Error("Request is not current; create a new request");
  return r;
}
export function runWorkspaceCommand(
  state: Workspace,
  actor: Actor,
  command: WorkspaceCommand,
  options: {
    now?: string;
    artifacts?: string;
    principal?: "human" | "agent";
  } = {},
): Effect.Effect<Workspace, WorkspaceError> {
  return Effect.tryPromise({
    try: async () => {
      if (
        options.principal === "agent" &&
        command.type !== "prepare" &&
        command.type !== "verify"
      )
        throw new Error(
          "Agent permission denied; a human must perform this operation",
        );
      const next = structuredClone(workspaceSchema.parse(state));
      const now = options.now ?? new Date().toISOString();
      date.parse(now);
      let detail = "";
      if (command.type === "sources.update") {
        requireActor(actor, ["board", "training"]);
        const value = sourceSchema.parse(command.records);
        next.sources =
          actor === "board"
            ? {
                ...next.sources,
                licenseActive: value.licenseActive,
                jurisdiction: value.jurisdiction,
                licenseValidUntil: value.licenseValidUntil,
              }
            : {
                ...next.sources,
                trainingHours: value.trainingHours,
                trainingValidUntil: value.trainingValidUntil,
              };
        detail =
          "Updated source record; existing signed credentials are unchanged.";
      } else if (command.type === "template.apply") {
        requireActor(actor, ["board", "training"]);
        const doc = templateSchema.parse(command.document);
        if (
          doc.issuer !== actor ||
          doc.schema !== `attest.workspace.${actor}.v1`
        )
          throw new Error("Template issuer or schema mismatch");
        const shape =
          actor === "board"
            ? z
                .object({
                  active: z.boolean(),
                  jurisdiction: z.enum(["MI", "OH", "NY"]),
                  validUntil: date,
                })
                .strict()
            : z
                .object({
                  hours: z.number().int().min(0).max(10000),
                  validUntil: date,
                })
                .strict();
        const fields = shape.parse(doc.claims);
        next.sources = sourceSchema.parse(
          actor === "board"
            ? {
                ...next.sources,
                licenseActive: (fields as { active: boolean }).active,
                jurisdiction: (fields as { jurisdiction: string }).jurisdiction,
                licenseValidUntil: fields.validUntil,
              }
            : {
                ...next.sources,
                trainingHours: (fields as { hours: number }).hours,
                trainingValidUntil: fields.validUntil,
              },
        );
        detail = "Applied validated issuance template; no credential issued.";
      } else if (command.type === "wallet.update") {
        const document = walletSchema.parse(command.document),
          existing = next.wallets.find((w) => w.id === actor)!;
        if (
          document.id !== actor ||
          canonicalJson({ ...document, name: "" }) !==
            canonicalJson({ ...existing, name: "" })
        )
          throw new Error(
            "Only the display name can be edited; demo roles, keys and permissions are fixed",
          );
        next.wallets = next.wallets.map((w) => (w.id === actor ? document : w));
        detail = "Updated wallet display name; authority unchanged.";
      } else if (command.type === "issue") {
        requireActor(actor, ["board", "training"]);
        if (!command.approved)
          throw new Error("Explicit issuance approval required");
        const issuer = actor as Source,
          credentialId = crypto.randomUUID();
        const draft = requestDraft(now),
          req = requirements(draft, issuer, credentialId, draft.challenge);
        const fields =
          issuer === "board"
            ? {
                credentialId,
                licenseScope: `${next.sources.licenseActive ? "active" : "inactive"}:${next.sources.jurisdiction}`,
                validUntil: next.sources.licenseValidUntil.slice(0, 10),
              }
            : {
                credentialId,
                hours: next.sources.trainingHours,
                validUntil: next.sources.trainingValidUntil.slice(0, 10),
              };
        const credential: WorkspaceCredential = {
          id: credentialId,
          issuer,
          subject,
          issuedAt: now,
          pod: issueCriteriaPod(req, fields, key(issuer)).toJSON(),
        };
        next.credentials.push(credential);
        next.statuses.push(statusFor(credential, "active", now));
        next.prepared = null;
        detail = `Issued ${issuer} credential ${credentialId} to Jordan’s wallet.`;
      } else if (command.type === "request.create") {
        requireActor(actor, ["hospital"]);
        const request = requestSchema.parse(command.document);
        if (
          Date.parse(request.createdAt) > Date.parse(now) ||
          Date.parse(request.expiresAt) <= Date.parse(now)
        )
          throw new Error("Request must be current");
        if (
          next.request?.id === request.id ||
          next.history.some(
            (h) => h.action === "request.create" && h.detail === request.id,
          )
        )
          throw new Error("Use a fresh request ID");
        next.request = request;
        next.requestSignature = sign(request, "hospital");
        next.prepared = null;
        detail = request.id;
      } else if (command.type === "status.availability") {
        requireActor(actor, ["hospital"]);
        next.statusAvailable = command.available;
        detail = command.available
          ? "Local status service available"
          : "Simulated status outage";
      } else if (
        command.type === "status.refresh" ||
        command.type === "revoke"
      ) {
        requireActor(actor, ["board", "training"]);
        if (command.type === "revoke" && !command.approved)
          throw new Error("Explicit revocation approval required");
        const credential =
          command.type === "revoke"
            ? next.credentials.find((c) => c.id === command.credentialId)
            : null;
        if (
          command.type === "revoke" &&
          (!credential || credential.issuer !== actor)
        )
          throw new Error(
            "Only the original issuer can revoke this credential",
          );
        next.statuses = next.statuses.map((s) =>
          s.issuer === actor &&
          (command.type === "status.refresh" ||
            s.credentialId === command.credentialId)
            ? statusFor(
                next.credentials.find((c) => c.id === s.credentialId)!,
                command.type === "revoke" ? "revoked" : s.state,
                now,
              )
            : s,
        );
        detail =
          command.type === "revoke"
            ? `Revoked ${command.credentialId}`
            : "Refreshed signed status; revoked credentials stay revoked.";
      } else if (command.type === "prepare") {
        requireActor(actor, ["jordan"]);
        const request = activeRequest(next, now),
          digest = await commitValue(request);
        if (request.subject !== subject)
          throw new Error("Request is for a different subject");
        const items: WorkspacePresentation["items"] = [];
        for (const issuer of ["board", "training"] as const) {
          const credential = [...next.credentials]
            .reverse()
            .find((c) => c.issuer === issuer);
          if (!credential)
            throw new Error(`Missing evidence from ${actorNames[issuer]}`);
          const status = next.statuses.find(
            (s) => s.credentialId === credential.id,
          );
          if (
            !next.statusAvailable ||
            !status ||
            !authentic(statusValue(status), status.signature, issuer) ||
            Date.parse(status.checkedAt) > Date.parse(now) ||
            Date.parse(now) - Date.parse(status.checkedAt) >
              request.statusMaxAgeSeconds * 1000
          )
            throw new Error(
              "Unable to verify: fresh signed status is unavailable",
            );
          if (status.state !== "active")
            throw new Error(`Credential from ${actorNames[issuer]} is revoked`);
          const req = requirements(request, issuer, credential.id, digest);
          if (!checkCredential(credential.pod, req))
            throw new Error(
              `Evidence from ${actorNames[issuer]} does not meet this request`,
            );
          items.push(
            request.disclosure === "private-proof"
              ? {
                  credentialId: credential.id,
                  issuer,
                  proof: await proveCriteria(
                    POD.fromJSON(credential.pod),
                    req,
                    options.artifacts,
                  ),
                }
              : {
                  credentialId: credential.id,
                  issuer,
                  credential: credential.pod,
                },
          );
        }
        const unsigned = {
          id: crypto.randomUUID(),
          requestDigest: digest,
          requestId: request.id,
          holder: "jordan" as const,
          audience: "hospital" as const,
          createdAt: now,
          items,
        };
        next.prepared = { ...unsigned, signature: sign(unsigned, "jordan") };
        detail = "Prepared a request-bound presentation locally. Nothing sent.";
      } else if (command.type === "send") {
        requireActor(actor, ["jordan"]);
        if (!command.approved)
          throw new Error("Explicit disclosure approval required");
        const request = activeRequest(next, now),
          p = next.prepared;
        if (!p || p.requestDigest !== (await commitValue(request)))
          throw new Error(
            "Prepare a presentation for the current request first",
          );
        const { signature, ...unsigned } = p;
        if (!authentic(unsigned, signature, "jordan"))
          throw new Error("Invalid holder signature");
        if (next.presentations.some((item) => item.requestId === request.id))
          throw new Error(
            "This request already has a presentation; replay rejected",
          );
        next.presentations.push(p);
        next.prepared = null;
        detail = `Approved disclosure and sent ${p.id} to the hospital.`;
      } else if (command.type === "verify") {
        requireActor(actor, ["hospital"]);
        const request = activeRequest(next, now),
          p = next.presentations.find((p) => p.requestId === request.id);
        if (!p) throw new Error("No presentation for the current request");
        const { signature, ...unsigned } = p;
        const binding =
          p.requestDigest === (await commitValue(request)) &&
          p.audience === "hospital" &&
          p.holder === "jordan" &&
          Date.parse(p.createdAt) >= Date.parse(request.createdAt) &&
          Date.parse(p.createdAt) <= Date.parse(now);
        let cryptoValid = authentic(unsigned, signature, "jordan");
        let recognized =
          p.items.length === 2 &&
          new Set(p.items.map((i) => i.issuer)).size === 2 &&
          new Set(p.items.map((i) => i.credentialId)).size === 2;
        let current: Check["result"] = "pass";
        let policy = binding && recognized;
        for (const item of p.items) {
          const req = requirements(
            request,
            item.issuer,
            item.credentialId,
            p.requestDigest,
          );
          // This demo board is recognized only for Michigan licenses.
          recognized &&=
            item.issuer !== "board" ||
            request.requirements.jurisdiction === "MI";
          if (item.credential) {
            const pod = POD.fromJSON(item.credential);
            recognized &&=
              pod.signerPublicKey === publicKey(item.issuer) &&
              pod.content.asEntries().schema?.value === req.schema;
          }
          if (request.disclosure === "private-proof") {
            const ok =
              !!item.proof &&
              !item.credential &&
              (await verifyCriteria(item.proof, req, options.artifacts));
            cryptoValid &&= ok;
            policy &&= ok;
          } else {
            const ok =
              !!item.credential &&
              !item.proof &&
              checkCredential(item.credential, req);
            cryptoValid &&=
              !!item.credential &&
              POD.fromJSON(item.credential).verifySignature();
            policy &&= ok;
          }
          const status = next.statuses.find(
            (s) =>
              s.credentialId === item.credentialId && s.issuer === item.issuer,
          );
          if (
            !next.statusAvailable ||
            !status ||
            !authentic(statusValue(status), status.signature, item.issuer) ||
            Date.parse(status.checkedAt) > Date.parse(now) ||
            Date.parse(now) - Date.parse(status.checkedAt) >
              request.statusMaxAgeSeconds * 1000
          ) {
            if (current !== "fail") current = "pending";
          } else if (status.state === "revoked") current = "fail";
        }
        policy &&= recognized;
        const checks: Check[] = [
          {
            name: "Authentic",
            result: cryptoValid ? "pass" : "fail",
            detail:
              request.disclosure === "private-proof"
                ? "Holder signature and both request-specific GPC proofs checked."
                : "Holder and disclosed credential signatures checked; no zero-knowledge proof.",
          },
          {
            name: "Recognized",
            result: recognized ? "pass" : "fail",
            detail:
              "Board key is accepted only for the license schema; training key only for training. Both independent sources are required.",
          },
          {
            name: "Current",
            result: current,
            detail:
              current === "pass"
                ? "Signed issuer status is active and within the request’s freshness limit."
                : current === "fail"
                  ? "An issuer revoked a presented credential."
                  : "Fresh authenticated status is unavailable; no approval can be made.",
          },
          {
            name: "Meets your request",
            result: policy ? "pass" : "fail",
            detail:
              "Checks subject, holder, audience, full request digest, schema, jurisdiction, active license, training threshold and validity through request expiry date.",
          },
        ];
        next.decisions.push({
          apiVersion: WORKSPACE_VERSION,
          kind: "DecisionRecord",
          requestId: request.id,
          presentationId: p.id,
          checkedAt: now,
          result: checks.some((c) => c.result === "fail")
            ? "rejected"
            : checks.some((c) => c.result === "pending")
              ? "pending"
              : "approved",
          checks,
        });
        detail = `Decision: ${next.decisions.at(-1)!.result}. Re-verification uses fresh status; previous decisions remain historical.`;
      }
      next.history.push({ at: now, actor, action: command.type, detail });
      return next;
    },
    catch: (cause) =>
      new WorkspaceError(
        cause instanceof z.ZodError
          ? z.prettifyError(cause)
          : cause instanceof Error
            ? cause.message
            : String(cause),
      ),
  });
}

/** Role-specific read projection. Local demo storage itself is not an isolation boundary. */
export function inspectWorkspace(state: Workspace, actor: Actor) {
  const wallet = state.wallets.find((w) => w.id === actor);
  const history = state.history.filter((h) => h.actor === actor);
  if (actor === "jordan")
    return {
      wallet,
      credentials: state.credentials,
      request: state.request,
      disclosure: state.request ? disclosurePreview(state.request) : null,
      prepared: state.prepared,
      sent: state.presentations,
      history,
    };
  if (actor === "hospital")
    return {
      wallet,
      request: state.request,
      presentations: state.presentations,
      decisions: state.decisions,
      statusAvailable: state.statusAvailable,
      history,
    };
  return {
    wallet,
    source:
      actor === "board"
        ? {
            active: state.sources.licenseActive,
            jurisdiction: state.sources.jurisdiction,
            validUntil: state.sources.licenseValidUntil,
          }
        : {
            hours: state.sources.trainingHours,
            validUntil: state.sources.trainingValidUntil,
          },
    issued: state.credentials.filter((c) => c.issuer === actor),
    statuses: state.statuses.filter((s) => s.issuer === actor),
    history,
  };
}
