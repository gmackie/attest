import type {
  DurableObjectNamespace,
  DurableObjectState,
  Fetcher,
} from "@cloudflare/workers-types";
import {
  createPublicClient,
  createWalletClient,
  http,
  verifyMessage,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { Effect } from "effect";
import { z } from "zod";
import { commitValue, canonicalJson } from "@attest/core";
import { institutionAbi, checkedHash } from "@attest/chain-evm";
import {
  institutionCommandSchema,
  commandMessage,
} from "../../../packages/demo/src/institution-service";
import {
  institutionDirectory,
  institutionSigningKeys,
  issueInstitutionCredential,
  journeyRequestSchema,
  verifyJourney,
  type JourneyPresentation,
} from "../../../packages/demo/src/testnet-journey";
import artifact from "../../web/public/contracts/InstitutionRegistry.json";
type Bundle = {
  institutions: {
    id: number;
    address: string;
    credentialPublicKey: string;
    evmPrivateKey: Hex;
    credentialPrivateKey: string;
  }[];
};
type Env = {
  ASSETS: Fetcher;
  INSTITUTIONS: DurableObjectNamespace;
  INSTITUTION_WALLETS: string;
  SEPOLIA_RPC_URL: string;
};
const rpc = (env: Env) =>
  createPublicClient({
    chain: sepolia,
    transport: http(env.SEPOLIA_RPC_URL, { timeout: 15000, retryCount: 1 }),
  });
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const signedSchema = z
  .object({
    command: institutionCommandSchema,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();
async function registryCheck(env: Env, registry: Address) {
  const client = rpc(env);
  if ((await client.getChainId()) !== 11155111)
    throw new ServiceError(503, "RPC is not Ethereum Sepolia");
  const code = await client.getCode({ address: registry });
  if (code !== artifact.deployedBytecode)
    throw new ServiceError(400, "Unsupported registry bytecode");
  const wallets = await Promise.all(
    institutionDirectory.institutions.map((_, i) =>
      client.readContract({
        address: registry,
        abi: institutionAbi,
        functionName: "institutions",
        args: [BigInt(i)],
      }),
    ),
  );
  const keys = await Promise.all(
    institutionSigningKeys.map((_, i) =>
      client.readContract({
        address: registry,
        abi: institutionAbi,
        functionName: "credentialKeys",
        args: [BigInt(i)],
      }),
    ),
  );
  const expected = await Promise.all(institutionSigningKeys.map(commitValue));
  if (
    wallets.some(
      (v, i) =>
        v.toLowerCase() !==
        institutionDirectory.institutions[i]!.address.toLowerCase(),
    ) ||
    keys.some((v, i) => v !== expected[i])
  )
    throw new ServiceError(
      400,
      "Registry does not authorize these demo institution wallets",
    );
  return client;
}
async function saltFor(secret: string, value: unknown) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(canonicalJson(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/"))
      return env.ASSETS.fetch(request as never) as unknown as Promise<Response>;
    if (url.pathname === "/api/v2/institutions" && request.method === "GET")
      return response({
        chainId: 11155111,
        institutions: institutionDirectory.institutions,
        serviceConfigured: !!env.INSTITUTION_WALLETS,
      });
    if (
      request.method !== "POST" ||
      !["/api/v2/credentials", "/api/v2/decisions"].includes(url.pathname)
    )
      return response({ error: "Not found" }, 404);
    if (Number(request.headers.get("content-length") ?? 0) > 100000)
      return response({ error: "Request too large" }, 413);
    try {
      const reader = request.body?.getReader();
      if (!reader) return response({ error: "Missing request body" }, 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 100000) {
          await reader.cancel();
          return response({ error: "Request too large" }, 413);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const body = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(body);
      const id = url.pathname.endsWith("credentials")
        ? signedSchema.parse(parsed).command.institution
        : 3;
      return (await env.INSTITUTIONS.get(
        env.INSTITUTIONS.idFromName(`institution-v2-${id}`),
      ).fetch(
        new Request(`https://institution.internal${url.pathname}`, {
          method: "POST",
          body,
        }) as never,
      )) as unknown as Response;
    } catch {
      return response({ error: "Invalid institution request" }, 400);
    }
  },
};
export class InstitutionService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  async fetch(request: Request): Promise<Response> {
    // Serialize each institution’s transactions; state only contains public txs and counters.
    const result = this.tail.then(() =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => this.handle(request),
          catch: (e) =>
            e instanceof ServiceError
              ? e
              : new ServiceError(
                  503,
                  "Institution temporarily unavailable. Retry this same request; no new credential is needed.",
                ),
        }),
      ),
    );
    this.tail = result.catch(() => {});
    try {
      return await result;
    } catch (e) {
      return response(
        { error: e instanceof Error ? e.message : "Service unavailable" },
        e instanceof ServiceError ? e.status : 503,
      );
    }
  }
  private async budget(account: string, id: number) {
    const day = new Date().toISOString().slice(0, 10),
      daily = `budget:${day}`,
      user = `user:${day}:${account}`;
    const all = (await this.state.storage.get<number>(daily)) ?? 0,
      count = (await this.state.storage.get<number>(user)) ?? 0;
    if (all >= 100 || count >= 8)
      throw new ServiceError(
        429,
        "Daily sponsored transaction allowance reached. Try tomorrow.",
      );
    await this.state.storage.put({ [daily]: all + 1, [user]: count + 1 });
  }
  private identity(id: number) {
    if (!this.env.INSTITUTION_WALLETS)
      throw new ServiceError(
        503,
        "Institution wallets have not been configured",
      );
    const keys = (JSON.parse(this.env.INSTITUTION_WALLETS) as Bundle)
      .institutions[id];
    if (
      !keys ||
      privateKeyToAccount(keys.evmPrivateKey).address.toLowerCase() !==
        institutionDirectory.institutions[id]!.address.toLowerCase() ||
      keys.credentialPublicKey !==
        institutionDirectory.institutions[id]!.credentialPublicKey
    )
      throw new ServiceError(503, "Institution wallet configuration mismatch");
    return keys;
  }
  private async transact(
    id: number,
    holder: Address,
    registry: Address,
    operation: string,
    functionName: "grant" | "revoke" | "recordDecision",
    args: readonly unknown[],
  ) {
    const keys = this.identity(id),
      account = privateKeyToAccount(keys.evmPrivateKey),
      reader = rpc(this.env),
      wallet = createWalletClient({
        account,
        chain: sepolia,
        transport: http(this.env.SEPOLIA_RPC_URL),
      });
    const pending = await this.state.storage.get<string>("pending-operation");
    if (pending && pending !== operation) {
      const tx = await this.state.storage.get<{ hash: Hex; raw: Hex }>(pending);
      if (tx) {
        const receipt = await reader
          .getTransactionReceipt({ hash: tx.hash })
          .catch(() => null);
        if (!receipt) {
          try {
            await reader.sendRawTransaction({ serializedTransaction: tx.raw });
          } catch {}
          throw new ServiceError(
            503,
            "This institution is waiting for an earlier transaction. Retry shortly.",
          );
        }
      }
      await this.state.storage.delete("pending-operation");
    }
    let saved = await this.state.storage.get<{ hash: Hex; raw: Hex }>(
      operation,
    );
    if (!saved) {
      await reader.simulateContract({
        account,
        address: registry,
        abi: institutionAbi,
        functionName,
        args: args as never,
      });
      const { encodeFunctionData } = await import("viem");
      const prepared = await wallet.prepareTransactionRequest({
        account,
        to: registry,
        data: encodeFunctionData({
          abi: institutionAbi,
          functionName,
          args: args as never,
        }),
      });
      const fee = prepared.maxFeePerGas ?? prepared.gasPrice ?? 0n;
      if (fee > 20_000_000_000n || prepared.gas * fee > 2_000_000_000_000_000n)
        throw new ServiceError(
          503,
          "Sepolia gas exceeds the demo sponsorship limit",
        );
      if (
        (await reader.getBalance({ address: account.address })) <
        prepared.gas * fee
      )
        throw new ServiceError(
          503,
          `${institutionDirectory.institutions[id]!.name} needs Sepolia test ETH. See institution wallets on the launch screen.`,
        );
      await this.budget(holder, id);
      const raw = await wallet.signTransaction(prepared);
      saved = { hash: keccak256(raw), raw };
      // Persist only public signed calldata BEFORE broadcast for safe retries after crashes.
      await this.state.storage.put({
        [operation]: saved,
        "pending-operation": operation,
      });
    }
    const existing = await reader
      .getTransactionReceipt({ hash: saved.hash })
      .catch(() => null);
    if (existing) {
      if (existing.status !== "success")
        throw new ServiceError(
          409,
          "Institution transaction reverted; start a new journey",
        );
      await this.state.storage.delete("pending-operation");
      return saved.hash;
    }
    try {
      await reader.sendRawTransaction({ serializedTransaction: saved.raw });
    } catch {
      /* Already known may be pending; receipt lookup is authoritative. */
    }
    const receipt = await reader.waitForTransactionReceipt({
      hash: saved.hash,
      timeout: 45000,
    });
    if (receipt.status !== "success")
      throw new ServiceError(
        409,
        "Institution transaction reverted; start a new journey",
      );
    await this.state.storage.delete("pending-operation");
    return saved.hash;
  }
  private async handle(request: Request): Promise<Response> {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("credentials")) {
      const { command: c, signature } = signedSchema.parse(body),
        expiry = Date.parse(c.expiresAt);
      if (expiry <= Date.now() || expiry > Date.now() + 10 * 60000)
        throw new ServiceError(
          401,
          "Wallet request expired; sign a new request",
        );
      if (
        !(await verifyMessage({
          address: c.account as Address,
          message: commandMessage(c),
          signature: signature as Hex,
        }))
      )
        throw new ServiceError(
          401,
          "Wallet signature does not authorize this request",
        );
      const client = await registryCheck(this.env, c.registry as Address),
        keys = this.identity(c.institution);
      const journey = checkedHash(await commitValue(c.journey)),
        slot = `tx:${c.registry}:${c.account}:${journey}:${c.institution}:${c.action}`;
      const raw = await client.readContract({
        address: c.registry as Address,
        abi: institutionAbi,
        functionName: "records",
        args: [c.account as Address, journey, c.institution],
      });
      if (c.action === "revoke") {
        if (raw[1] !== (await commitValue(c.holderPublicKey)))
          throw new ServiceError(
            403,
            "Holder key does not match the issued record",
          );
        const hash = await this.transact(
          c.institution,
          c.account as Address,
          c.registry as Address,
          slot,
          "revoke",
          [c.account, journey, c.institution],
        );
        return response({ transactionHash: hash });
      }
      const expiryDay = Date.parse(c.validThrough);
      if (
        !Number.isFinite(expiryDay) ||
        new Date(expiryDay).toISOString().slice(0, 10) !== c.validThrough ||
        expiryDay < Date.now() ||
        expiryDay > Date.now() + 181 * 86400000
      )
        throw new ServiceError(
          400,
          "Choose a valid demo expiry within 180 days",
        );
      const source = {
        account: c.account,
        registry: c.registry,
        id: c.journey,
        holderPublicKey: c.holderPublicKey,
        issuerPublicKeys: institutionSigningKeys,
      };
      const salt = await saltFor(keys.credentialPrivateKey, {
        ...source,
        institution: c.institution,
        value: c.value,
        validThrough: c.validThrough,
      });
      const credential = issueInstitutionCredential(
          source,
          c.institution,
          c.value,
          keys.credentialPrivateKey,
          salt,
          c.validThrough,
        ),
        content = checkedHash(await commitValue(credential.contentID)),
        holderKey = checkedHash(await commitValue(c.holderPublicKey));
      if (
        raw[0] !== `0x${"0".repeat(64)}` &&
        (raw[0] !== content || raw[1] !== holderKey)
      )
        throw new ServiceError(
          409,
          "This institution already issued different contents for this journey",
        );
      const operationContents = await this.state.storage.get<string>(
        slot + ":content",
      );
      if (operationContents && operationContents !== content)
        throw new ServiceError(
          409,
          "An issuance with different contents is already pending",
        );
      await this.state.storage.put(slot + ":content", content);
      const hash = await this.transact(
        c.institution,
        c.account as Address,
        c.registry as Address,
        slot,
        "grant",
        [
          c.account,
          journey,
          c.institution,
          content,
          holderKey,
          BigInt(expiryDay / 1000 + 86399),
        ],
      );
      return response({ credential, transactionHash: hash });
    }
    const input = body as {
      request: unknown;
      presentation: JourneyPresentation;
    };
    const req = journeyRequestSchema.parse(input.request);
    if (
      canonicalJson(req.issuerPublicKeys) !==
      canonicalJson(institutionSigningKeys)
    )
      throw new ServiceError(403, "Unrecognized issuer keys");
    const client = await registryCheck(this.env, req.registry as Address),
      block = await client.getBlock({ blockTag: "latest" }),
      journey = checkedHash(await commitValue(req.journey));
    const records = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const r = await client.readContract({
          address: req.registry as Address,
          abi: institutionAbi,
          functionName: "records",
          args: [req.account as Address, journey, i],
          blockNumber: block.number,
        });
        return {
          content: r[0],
          holderKey: r[1],
          validUntil: r[2],
          revoked: r[3],
        };
      }),
    );
    const checks = await verifyJourney(
      input.presentation,
      req,
      records,
      block.timestamp,
    );
    if (checks.some((c) => !c.pass))
      return response(
        { error: "Northstar rejected the presentation", checks },
        422,
      );
    const digest = checkedHash(await commitValue(req)),
      proof = checkedHash(await commitValue(input.presentation));
    const hash = await this.transact(
      3,
      req.account as Address,
      req.registry as Address,
      `decision:${req.registry}:${req.account}:${digest}`,
      "recordDecision",
      [req.account, digest, proof],
    );
    return response({
      checks,
      transactionHash: hash,
      checkedBlock: block.number.toString(),
    });
  }
}
