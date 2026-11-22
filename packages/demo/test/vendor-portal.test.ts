import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { receiptVerdict, type AnchorCheck, type ReceiptVerification } from "../src/vendor-portal";

const good: ReceiptVerification = { local: { ok: true }, inclusion: true, matchesDecision: true };
const epoch = { epoch: 1, root: "a".repeat(64), firstSeq: 1, lastSeq: 1, size: 1, firstPrevHash: "0".repeat(64),
  lastLeafHash: "b".repeat(64), anchoredAt: 0, evidence: {} } as never;

describe("vendor portal receipt verdict (ATTE-20 L5)", () => {
  it("succeeds against a matching anchor, or honestly as sealed locally", () => {
    expect(receiptVerdict(good, { status: "anchored", address: "0x1", epoch, check: { ok: true } })).toBe("anchored");
    expect(receiptVerdict(good, { status: "not-configured" })).toBe("sealed-locally");
    expect(receiptVerdict(good, { status: "not-anchored", address: "0x1" })).toBe("sealed-locally");
  });
  it("fails when an anchor exists but the receipt does not match it, or the receipt is bad", () => {
    const mismatch: AnchorCheck = { status: "anchored", address: "0x1", epoch, check: { ok: false, reason: "root_mismatch" } };
    expect(() => receiptVerdict(good, mismatch)).toThrow("receipt_anchor_mismatch:root_mismatch");
    expect(() => receiptVerdict({ ...good, matchesDecision: false }, { status: "not-configured" })).toThrow("receipt_invalid");
    expect(() => receiptVerdict({ ...good, local: { ok: false, reason: "not_included" } }, { status: "not-configured" })).toThrow("receipt_invalid");
  });
  it("only emits completion analytics after the verdict, and labels the chooser card as a synthetic demo", () => {
    const ui = readFileSync(path.resolve(import.meta.dirname, "../../../apps/web/src/VendorPortal.tsx"), "utf8");
    expect(ui.indexOf("receiptVerdict(v, a)")).toBeLessThan(ui.indexOf('track("receipt_verified"'));
    const chooser = readFileSync(path.resolve(import.meta.dirname, "../../../apps/web/src/IndustryJourney.tsx"), "utf8");
    expect(chooser).toContain("Demo · synthetic credentials · demo PEP");
  });
});
