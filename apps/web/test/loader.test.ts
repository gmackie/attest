import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// The shipped journey loader (public/dataflare.js) is the canonical DATFLR-9 file with
// attest's CONFIG. attest routes by location.hash, so the loader must record the hash route.
const SOURCE = readFileSync(
  new URL("../public/dataflare.js", import.meta.url),
  "utf8",
);

function load(href: string) {
  const url = new URL(href);
  // biome-ignore lint/suspicious/noExplicitAny: objects from the vm sandbox are untyped
  const window: Record<string, any> = {};
  const location = {
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
    get origin() {
      return url.origin;
    },
    get href() {
      return url.href;
    },
  };
  // data-enabled="false" stops the loader before it fetches the SDK.
  vm.runInNewContext(SOURCE, {
    window,
    location,
    document: { currentScript: { dataset: { enabled: "false" } } },
    navigator: {},
    URL,
    URLSearchParams,
    decodeURIComponent,
  });
  return {
    internal: window.dataflare._internal,
    navigate(to: string) {
      url.href = new URL(to, url).href;
    },
  };
}

const ev = (event: string) => ({ id: "x", event, ts: 1, props: {} });

describe("journey loader config", () => {
  it("collects for project attest with hash routing on", () => {
    const { CONFIG } = load("https://attest.gmac.io/").internal;
    expect(CONFIG.project).toBe("attest");
    expect(CONFIG.hashRouting).toBe(true);
  });

  it("records each hash screen as its own page", () => {
    const l = load("https://attest.gmac.io/#/explore");
    const { beforeSend } = l.internal;
    expect(beforeSend(ev("$pageview")).url).toBe(
      "https://attest.gmac.io/#/explore",
    );
    l.navigate("/#/learn/standards");
    expect(beforeSend(ev("$pageleave")).url).toBe(
      "https://attest.gmac.io/#/explore",
    );
    expect(beforeSend(ev("$pageview")).url).toBe(
      "https://attest.gmac.io/#/learn/standards",
    );
  });

  it("drops the registry address carried in the hash query", () => {
    const l = load(
      "https://attest.gmac.io/#/demo/healthcare?registry=0x5FbDB2315678afecb367f032d93F642f64180aa3",
    );
    expect(l.internal.beforeSend(ev("$pageview")).url).toBe(
      "https://attest.gmac.io/#/demo/healthcare",
    );
  });
});
