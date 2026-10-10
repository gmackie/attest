import {
  readFile,
  writeFile,
  rename,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { Effect } from "effect";
import {
  actors,
  issuanceTemplate,
  trustProfile,
  createWorkspace,
  documentYaml,
  inspectWorkspace,
  parseWorkspaceDocument,
  requestDraft,
  runWorkspaceCommand,
  workspaceDocumentJsonSchema,
  workspaceSchema,
  type Actor,
  type WorkspaceCommand,
} from "@attest/demo";

const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
const json = args.includes("--json");
const output = (value: unknown) =>
  process.stdout.write(
    json ? JSON.stringify(value, null, 2) + "\n" : documentYaml(value),
  );
const help = `Attest local wallet demo — fictional data and public demo keys only.

pnpm attest init [--state ./wallet-demo.json]
pnpm attest inspect --actor jordan|board|training|hospital [--json]
pnpm attest document --actor jordan
pnpm attest template show --actor board|training
pnpm attest template apply --actor board|training --file template.yaml
pnpm attest trust --actor hospital
pnpm attest schema --json
pnpm attest request draft [--mode private-proof|disclosed-records]
pnpm attest request create --actor hospital --file request.yaml
pnpm attest wallet update --actor jordan --file wallet.yaml
pnpm attest source update --actor board|training --file source.json
pnpm attest issue --actor board|training --approve
pnpm attest prepare --actor jordan [--artifacts /path/to/gpc-artifacts]
pnpm attest send --actor jordan --approve
pnpm attest verify --actor hospital
pnpm attest revoke --actor board|training --credential ID --approve
pnpm attest status refresh --actor board|training
pnpm attest status offline|online --actor hospital

All commands support --json and --state PATH. Default state: ./attest-wallet-demo.json.
prepare writes only a local preview; send requires explicit disclosure approval.
Use inspect to see role-specific results. Full state is a local, unencrypted simulation;
--actor selects a demo participant, not an authenticated account. Do not store real data.
`;
if (!args.length || args.includes("--help")) {
  process.stdout.write(help);
  process.exit(0);
}

const program = Effect.tryPromise({
  try: async () => {
    const command = args[0],
      sub = args[1];
    const statePath = resolve(flag("--state") ?? "./attest-wallet-demo.json");
    if (command === "schema") {
      output(workspaceDocumentJsonSchema);
      return;
    }
    if (command === "request" && sub === "draft") {
      const draft = requestDraft(),
        mode = flag("--mode");
      if (mode && mode !== "private-proof" && mode !== "disclosed-records")
        throw new Error("Unknown disclosure mode");
      if (mode === "private-proof" || mode === "disclosed-records")
        draft.disclosure = mode;
      output(draft);
      return;
    }
    if (command === "init") {
      if (args.includes("--agent"))
        throw new Error(
          "Agent permission denied; a human must initialize a workspace",
        );
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify(createWorkspace(), null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      output({
        ok: true,
        state: statePath,
        next: "Issue credentials as board and training, then create a hospital request.",
      });
      return;
    }
    const actor = flag("--actor");
    if (!actors.includes(actor as Actor))
      throw new Error("Choose --actor jordan, board, training, or hospital");
    const load = async () =>
      workspaceSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    if (
      command === "inspect" ||
      command === "document" ||
      command === "trust" ||
      (command === "template" && sub === "show")
    ) {
      const state = await load();
      if (command === "template" && actor !== "board" && actor !== "training")
        throw new Error("Select an issuer");
      output(
        command === "trust"
          ? trustProfile
          : command === "template"
            ? issuanceTemplate(state, actor as "board" | "training")
            : command === "inspect"
              ? inspectWorkspace(state, actor as Actor)
              : state.wallets.find((w) => w.id === actor),
      );
      return;
    }
    let operation: WorkspaceCommand;
    const approved = args.includes("--approve");
    if (command === "issue" || command === "send")
      operation = { type: command, approved };
    else if (command === "prepare" || command === "verify")
      operation = { type: command };
    else if (command === "revoke")
      operation = {
        type: "revoke",
        credentialId: flag("--credential") ?? "",
        approved,
      };
    else if (command === "status" && sub === "refresh")
      operation = { type: "status.refresh" };
    else if (command === "status" && (sub === "online" || sub === "offline"))
      operation = { type: "status.availability", available: sub === "online" };
    else if (
      (command === "request" && sub === "create") ||
      (command === "wallet" && sub === "update") ||
      (command === "source" && sub === "update") ||
      (command === "template" && sub === "apply")
    ) {
      const file = flag("--file");
      if (!file) throw new Error("--file is required");
      const text = await readFile(resolve(file), "utf8");
      operation =
        command === "source"
          ? { type: "sources.update", records: JSON.parse(text) }
          : {
              type:
                command === "request"
                  ? "request.create"
                  : command === "template"
                    ? "template.apply"
                    : "wallet.update",
              document: parseWorkspaceDocument(text),
            };
    } else throw new Error("Unknown command. Run pnpm attest --help");
    // Exclusive writer lock and atomic replacement avoid lost updates and partial files.
    const lock = await open(`${statePath}.lock`, "wx", 0o600);
    const temporary = `${statePath}.${process.pid}.tmp`;
    try {
      const state = await load(),
        artifacts = flag("--artifacts");
      const next = await Effect.runPromise(
        runWorkspaceCommand(state, actor as Actor, operation, {
          ...(artifacts ? { artifacts } : {}),
          principal: args.includes("--agent") ? "agent" : "human",
        }),
      );
      await writeFile(temporary, JSON.stringify(next, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, statePath);
      output({
        ok: true,
        operation: operation.type,
        result: inspectWorkspace(next, actor as Actor),
      });
    } finally {
      await lock.close();
      await unlink(`${statePath}.lock`);
      await unlink(temporary).catch(() => {});
    }
  },
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
});
// GPC's worker pool can keep Node alive after a completed command. Flush output
// before exiting; all state writes and lock cleanup have already been awaited.
Effect.runPromise(program).then(
  () => {
    process.stdout.write("", () => process.exit(0));
  },
  (error) => {
    output({ ok: false, error: error.message });
    process.stdout.write("", () => process.exit(1));
  },
);
