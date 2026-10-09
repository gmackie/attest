import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect } from "vitest";

it("CLI persists a private-proof journey, enforces approval and exits after proof workers finish", () => {
  const root = path.resolve(import.meta.dirname, "../../.."),
    directory = mkdtempSync(path.join(tmpdir(), "attest-cli-test-"));
  const file = path.join(directory, "state.json"),
    requestFile = path.join(directory, "request.json");
  const artifacts = path.join(
    root,
    "packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
  );
  const invoke = (args: string[], success = true) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/cli/src/launch.mjs",
        ...args,
        "--state",
        file,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 45000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(success ? 0 : 1);
    return JSON.parse(result.stdout);
  };
  try {
    invoke(["init"]);
    invoke(["init"], false);
    const board = invoke(["issue", "--actor", "board", "--approve"]);
    invoke(["issue", "--actor", "training", "--approve"]);
    writeFileSync(requestFile, JSON.stringify(invoke(["request", "draft"])));
    invoke(["request", "create", "--actor", "hospital", "--file", requestFile]);
    invoke(["prepare", "--actor", "jordan", "--artifacts", artifacts]);
    const before = readFileSync(file, "utf8");
    invoke(["send", "--actor", "jordan"], false);
    invoke(["send", "--actor", "jordan", "--approve", "--agent"], false);
    expect(readFileSync(file, "utf8")).toBe(before);
    invoke(["send", "--actor", "jordan", "--approve"]);
    expect(
      invoke([
        "verify",
        "--actor",
        "hospital",
        "--artifacts",
        artifacts,
      ]).result.decisions.at(-1).result,
    ).toBe("approved");
    invoke([
      "revoke",
      "--actor",
      "board",
      "--credential",
      board.result.issued[0].id,
      "--approve",
    ]);
    expect(
      invoke([
        "verify",
        "--actor",
        "hospital",
        "--artifacts",
        artifacts,
      ]).result.decisions.at(-1).result,
    ).toBe("rejected");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120000);
