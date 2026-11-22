/**
 * attest-verifier Worker entry (verify.attest.gmac.io).
 *
 * GPC verification runs in the Worker through the same shims as the attest-demo
 * Worker: `snarkjs` is aliased to a noble BN254 Groth16 verifier and `fastfile` to
 * pinned verification keys from @pcd/proto-pod-gpc-artifacts 0.13.0, so no artifact
 * is fetched at verification time. POD/GPC is a beta, unaudited backend.
 */
import { publicClientEndpoint } from "@attest/chain-evm";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { Env } from "./config";
import { createHandler } from "./handler";
import { parseOrigins, withCors } from "./cors";

export { EnrollmentStore } from "./enrollment";
export { ReplayStore } from "./replay";

const client = (url: string) =>
  createPublicClient({ chain: sepolia, transport: http(url, { timeout: 10_000, retryCount: 1 }) });

const origins = new Map<string, Set<string>>();
const allowedOrigins = (env: Env) => {
  const raw = env.CORS_ORIGINS ?? "";
  let set = origins.get(raw);
  if (!set) origins.set(raw, (set = parseOrigins(raw)));
  return set;
};

const handler = withCors(allowedOrigins, "GET, POST", createHandler({
  endpoints: (config) => [
    publicClientEndpoint("primary", client(config.rpcUrls[0])),
    publicClientEndpoint("secondary", client(config.rpcUrls[1])),
  ],
}));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handler(request, env);
    } catch {
      return new Response(JSON.stringify({ code: "internal_error" }), {
        status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
  },
};
