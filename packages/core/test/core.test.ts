import { describe, expect, it } from "vitest";
import { canonicalJson, commitValue, merkleRoot } from "../src/index";

describe("commitments", () => {
  it("canonicalizes object key order", async () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    await expect(commitValue({ a: 1, b: 2 })).resolves.toBe(await commitValue({ b: 2, a: 1 }));
  });

  it("produces an order-independent evidence root", async () => {
    const a = await commitValue("a");
    const b = await commitValue("b");
    await expect(merkleRoot([a, b])).resolves.toBe(await merkleRoot([b, a]));
  });
});
