import { describe, expect, it } from "vitest";
import {
  assertTokenComposition, getTokenStoryFrame, tokenScenes,
} from "../src/token-story";

describe("token lifecycle explainer (educational state only)", () => {
  it("covers claims, optional NFT, two distinct proof paths, mint, transfer, portrait and revocation", () => {
    expect(tokenScenes.map((scene) => scene.id)).toEqual([
      "claim", "nft", "proof", "mint", "transfer", "passport", "revoked",
    ]);
    const before = getTokenStoryFrame(0);
    expect(before.claimNftVisible).toBe(false);
    expect(before.issuanceRecorded).toBe(false);
    expect(before.alice.amount).toBe(0);
    expect(getTokenStoryFrame(1).claimNftVisible).toBe(true);
    expect(getTokenStoryFrame(2).privateProofPrepared).toBe(true);
    expect(getTokenStoryFrame(3).entitlementSpent).toBe(true);
    expect(getTokenStoryFrame(5).passportVisible).toBe(true);
  });

  it("does not allow educational balance creation before conversion", () => {
    for (let index = 0; index < 3; index++) {
      const frame = getTokenStoryFrame(index);
      expect(frame.alice.amount + frame.bob.amount).toBe(0);
      expect(frame.entitlementSpent).toBe(false);
    }
  });

  it("conserves the four-channel token provenance during wallet transfer", () => {
    const minted = getTokenStoryFrame(3);
    const transferred = getTokenStoryFrame(4);
    expect(minted.alice.amount).toBe(200);
    expect(minted.bob.amount).toBe(80); // Bob starts with unrelated simulated gold holdings.
    expect(transferred.alice.amount).toBe(150);
    expect(transferred.bob.amount).toBe(130);
    for (const stage of tokenScenes.keys()) {
      const frame = getTokenStoryFrame(stage);
      expect(assertTokenComposition(frame.alice)).toBe(true);
      expect(assertTokenComposition(frame.bob)).toBe(true);
    }
    expect(
      (minted.alice.amount + minted.bob.amount),
    ).toBe(transferred.alice.amount + transferred.bob.amount);
    for (let channel = 0; channel < 4; channel++) {
      const before = minted.alice.composition[channel]! + minted.bob.composition[channel]!;
      const after = transferred.alice.composition[channel]! + transferred.bob.composition[channel]!;
      expect(before).toBeCloseTo(after);
    }
  });

  it("revocation changes claim status but does not erase previously released test tokens", () => {
    const before = getTokenStoryFrame(5);
    const after = getTokenStoryFrame(6);
    expect(before.claimRevoked).toBe(false);
    expect(after.claimRevoked).toBe(true);
    expect(after.entitlementSpent).toBe(true);
    expect(after.alice).toEqual(before.alice);
    expect(after.bob).toEqual(before.bob);
  });

  it("keeps trusted GPC bridge and native Poseidon-root circuit conceptually separate", () => {
    const bridge = getTokenStoryFrame(3, "bridge");
    const native = getTokenStoryFrame(3, "native");
    expect(bridge.path).toBe("bridge");
    expect(native.path).toBe("native");
    expect(native.alice).toEqual(bridge.alice);
    expect(() => getTokenStoryFrame(3, "invented" as "bridge")).toThrow();
  });

  it("rejects invalid scenes and impossible token compositions", () => {
    for (const invalid of [-1, 7, 1.5, NaN]) {
      expect(() => getTokenStoryFrame(invalid)).toThrow();
    }
    expect(assertTokenComposition({ amount: 40, composition: [4, 4, 4, 4] })).toBe(false);
    expect(assertTokenComposition({ amount: 1, composition: [-1, 0, 0, 2] })).toBe(false);
  });
});
