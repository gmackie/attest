import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "../src/analytics.ts";

const g = globalThis as { dataflare?: unknown };

describe("journey analytics helper", () => {
  afterEach(() => {
    delete g.dataflare;
  });

  it("no-ops when window.dataflare is missing", () => {
    expect(() => track("wallet_connected", { surface: "testnet" })).not.toThrow();
  });

  it("passes event names and props through", () => {
    const spy = vi.fn();
    g.dataflare = { track: spy };
    track("decision_recorded", { industry: "healthcare" });
    expect(spy).toHaveBeenCalledWith("decision_recorded", {
      industry: "healthcare",
    });
  });

  it("swallows errors from the loader", () => {
    g.dataflare = {
      track: () => {
        throw new Error("boom");
      },
    };
    expect(() => track("demo_completed")).not.toThrow();
  });
});
