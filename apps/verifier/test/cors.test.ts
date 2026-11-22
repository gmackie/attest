import { describe, expect, it } from "vitest";
import { parseOrigins, withCors } from "../src/cors";

describe("verifier CORS", () => {
  const env = { CORS_ORIGINS: JSON.stringify(["https://attest.gmac.io", "https://evil.example/path", "*", "http://example.com", "http://localhost:5173"]) };
  const handler = withCors((e: typeof env) => parseOrigins(e.CORS_ORIGINS), "GET, POST",
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  const call = (method: string, origin?: string) =>
    handler(new Request("https://verify.attest.example/v1/presentations", { method, headers: origin ? { origin } : {} }), env);

  it("allows exact listed origins only, never wildcards or credentials", async () => {
    expect([...parseOrigins(env.CORS_ORIGINS)]).toEqual(["https://attest.gmac.io", "http://localhost:5173"]);
    const pre = await call("OPTIONS", "https://attest.gmac.io");
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://attest.gmac.io");
    expect(pre.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    expect((await call("POST", "https://attest.gmac.io")).headers.get("access-control-allow-origin")).toBe("https://attest.gmac.io");
  });
  it("refuses other origins and leaves same-origin and server calls untouched", async () => {
    expect((await call("OPTIONS", "https://evil.example")).status).toBe(403);
    expect((await call("POST", "https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    expect((await call("POST")).headers.get("access-control-allow-origin")).toBeNull();
    expect(parseOrigins("not json").size).toBe(0);
    expect(parseOrigins(undefined).size).toBe(0);
  });
});
