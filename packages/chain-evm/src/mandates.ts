/**
 * MandateAccount client (experimental, testnet only): ABI, Attest mandate -> on-chain policy mapping,
 * ERC-4337 v0.7 PackedUserOperation building and hashing, and the two signatures every session-key spend
 * needs: the agent session key over the userOpHash, and the Gatekeeper decision co-signature (EIP-712,
 * domain bound to chainId and the account) over entry point, userOpHash, nonce, mandate digest, token,
 * payee, amount, total gas limit, max fee per gas and an expiry.
 *
 * A Gatekeeper co-signature only says "Gatekeeper's policy allowed this exact transfer, at this maximum gas
 * cost, at signing time". It is not a proof of anything else and does not replace the on-chain caps.
 *
 * The co-signer MUST NOT sign a bare userOpHash or caller-supplied decision fields. It must receive the full
 * PackedUserOperation and derive every field with `gatekeeperDecisionFromUserOp` (which recomputes the hash),
 * as `cosignMandateUserOp` does.
 *
 * Only allowlisted test networks are accepted, and signing helpers check the RPC's chain id first. The local
 * allowlist is deliberately small so it can be replaced by the shared networks module later.
 */
import {
  concatHex, decodeAbiParameters, encodeAbiParameters, getAbiItem, hashTypedData, keccak256, pad, parseAbi, size, slice,
  toFunctionSelector, type Address, type Hex, type TypedDataDomain,
} from "viem";

export const ENTRY_POINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
export const SIG_VALIDATION_FAILED = 1n;
/** anvil/hardhat, legacy local, Sepolia, Base Sepolia. Mirrors TestnetOnly in MandateAccount.sol. */
export const MANDATE_ACCOUNT_CHAIN_IDS: readonly number[] = [31337, 1337, 11155111, 84532];

const userOpTuple =
  "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";

export const GATEKEEPER_DECISION_TYPE =
  "GatekeeperDecision(address entryPoint,bytes32 userOpHash,uint256 nonce,bytes32 mandateDigest,address token,address payee,uint256 amount,uint256 totalGasLimit,uint256 maxFeePerGas,uint48 validUntil)";

export const mandateAccountAbi = parseAbi([
  "constructor(address entryPoint_,address owner_,address gatekeeper_,address guardian_)",
  "function entryPoint() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function gatekeeper() view returns (address)",
  "function guardian() view returns (address)",
  "function paused() view returns (bool)",
  "function consumed(bytes32) view returns (bool)",
  "function payeeAllowed(bytes32,address) view returns (bool)",
  "function remaining(bytes32 digest) view returns (uint256)",
  "function getMandate(bytes32 digest) view returns ((bytes32 parent,address token,uint48 validAfter,uint48 validUntil,uint8 depth,bool exists,bool revoked,uint256 maxPerAction,uint256 maxTotal,uint256 spent,uint256 maxGasCost))",
  "function getSessionKey(address key) view returns ((bytes32 mandate,uint48 validAfter,uint48 validUntil,bool exists,bool revoked))",
  "function GATEKEEPER_DECISION_TYPEHASH() view returns (bytes32)",
  "function domainSeparator() view returns (bytes32)",
  "function gatekeeperDigest((address entryPoint,bytes32 userOpHash,uint256 nonce,bytes32 mandateDigest,address token,address payee,uint256 amount,uint256 totalGasLimit,uint256 maxFeePerGas,uint48 validUntil) d) view returns (bytes32)",
  "function proposeOwner(address next)",
  "function acceptOwner()",
  "function setGatekeeper(address next)",
  "function setGuardian(address next)",
  "function registerMandate(bytes32 digest,bytes32 parent,address token,uint256 maxPerAction,uint256 maxTotal,uint256 maxGasCost,uint48 validAfter,uint48 validUntil,address[] payees)",
  "function revokeMandate(bytes32 digest)",
  "function registerSessionKey(address key,bytes32 mandate,uint48 validAfter,uint48 validUntil)",
  "function revokeSessionKey(address key)",
  "function execute(address target,uint256 value,bytes data) returns (bytes)",
  "function pause()",
  "function unpause()",
  `function validateUserOp(${userOpTuple} userOp,bytes32 userOpHash,uint256 missingAccountFunds) returns (uint256)`,
  `function executeUserOp(${userOpTuple} userOp,bytes32 userOpHash)`,
  "event MandateSpend(bytes32 indexed mandate,bytes32 indexed userOpHash,address indexed payee,address token,uint256 amount)",
]);

/** ERC-20 subset used with the test-only TestStablecoin. */
export const testStablecoinAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function mint(address to,uint256 amount)",
]);

export class MandateAccountError extends Error {
  readonly _tag = "MandateAccountError";
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "MandateAccountError";
  }
}
const fail = (code: string, detail?: string): never => { throw new MandateAccountError(code, detail); };

/** Allowlist, not a denylist: anything but a known test network is refused. */
export function assertTestnetChain(chainId: number): void {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail("invalid_chain_id");
  if (!MANDATE_ACCOUNT_CHAIN_IDS.includes(chainId))
    fail("chain_not_allowed", `MandateAccount is testnet-only pending security review (chain ${chainId})`);
}

/** Read the chain id from the RPC and require it to be allowlisted and equal to the one being signed for. */
export async function assertRpcChain(client: { getChainId(): Promise<number> }, chainId: number): Promise<void> {
  assertTestnetChain(chainId);
  const actual = await client.getChainId();
  if (actual !== chainId) fail("chain_id_mismatch", `rpc reports ${actual}, signing for ${chainId}`);
}

const uint48Max = 2n ** 48n - 1n;
const uint128Max = 2n ** 128n - 1n;
const hex64 = /^[0-9a-f]{64}$/;

/** Attest mandate digests are 64 lowercase hex chars (SHA-256 of canonical JSON); on-chain they are bytes32. */
export function mandateDigestToBytes32(digest: string): Hex {
  if (!hex64.test(digest)) fail("invalid_mandate_digest");
  return `0x${digest}`;
}

/** Structural subset of `@attest/mandates` AgentMandate that the on-chain policy mirrors. */
export interface MandatePolicySource {
  validFrom: number;
  validUntil: number;
  parentDigest?: string;
  constraints: { money?: { currency: string; maxPerActionMinor: number; maxTotalMinor: number } };
}

export interface MandateRegistration {
  digest: Hex;
  parent: Hex;
  token: Address;
  maxPerAction: bigint;
  maxTotal: bigint;
  /** Wei; bounds (verificationGasLimit + callGasLimit + preVerificationGas) * maxFeePerGas per op. */
  maxGasCost: bigint;
  validAfter: number;
  validUntil: number;
  payees: Address[];
}

/**
 * Map a verified Attest mandate to registerMandate arguments. Times are milliseconds in the mandate and
 * seconds on-chain (validFrom rounds up, validUntil rounds down, so the on-chain window never widens).
 * `tokens` maps the mandate's ISO currency to the ERC-20 that represents it on this chain; `unitsPerMinor`
 * converts minor units (e.g. cents) to token base units (10_000n for a 6-decimal USD token). `maxGasCostWei`
 * is an operator choice (the mandate format has no gas field).
 */
export function mandateRegistration(
  mandate: MandatePolicySource,
  digest: string,
  options: { tokens: Readonly<Record<string, Address>>; payees: readonly Address[]; unitsPerMinor: bigint; maxGasCostWei: bigint },
): MandateRegistration {
  const money = mandate.constraints.money ?? fail("mandate_has_no_money_limit");
  const token = options.tokens[money.currency] ?? fail("unsupported_currency", money.currency);
  if (options.unitsPerMinor <= 0n) fail("invalid_unit_scale");
  if (options.maxGasCostWei < 0n) fail("invalid_gas_cap");
  if (options.payees.length === 0 || options.payees.length > 64) fail("invalid_payees");
  const validAfter = Math.ceil(mandate.validFrom / 1000), validUntil = Math.floor(mandate.validUntil / 1000);
  if (!(validAfter < validUntil)) fail("invalid_mandate_time");
  if (money.maxPerActionMinor <= 0 || money.maxPerActionMinor > money.maxTotalMinor) fail("invalid_money_limit");
  return {
    digest: mandateDigestToBytes32(digest),
    parent: mandate.parentDigest === undefined ? pad("0x", { size: 32 }) : mandateDigestToBytes32(mandate.parentDigest),
    token,
    maxPerAction: BigInt(money.maxPerActionMinor) * options.unitsPerMinor,
    maxTotal: BigInt(money.maxTotalMinor) * options.unitsPerMinor,
    maxGasCost: options.maxGasCostWei,
    validAfter,
    validUntil,
    payees: [...options.payees],
  };
}

export const registerMandateArgs = (r: MandateRegistration) =>
  [r.digest, r.parent, r.token, r.maxPerAction, r.maxTotal, r.maxGasCost, r.validAfter, r.validUntil, r.payees] as const;

/** ERC-4337 v0.7 PackedUserOperation, as passed to validateUserOp. */
export interface PackedUserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface MandateSpend {
  mandateDigest: Hex;
  token: Address;
  payee: Address;
  amount: bigint;
}

export const EXECUTE_USER_OP_SELECTOR = toFunctionSelector(getAbiItem({ abi: mandateAccountAbi, name: "executeUserOp" }));
const spendParams = [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }] as const;

/** callData = executeUserOp.selector ++ abi.encode(mandate, token, payee, amount). Nothing else is executable. */
export function encodeMandateSpendCall(spend: MandateSpend): Hex {
  if (spend.amount <= 0n) fail("invalid_amount");
  return concatHex([EXECUTE_USER_OP_SELECTOR, encodeAbiParameters(spendParams, [spend.mandateDigest, spend.token, spend.payee, spend.amount])]);
}

/** Inverse of encodeMandateSpendCall, with the same exact-shape rule the contract applies. */
export function decodeMandateSpendCall(callData: Hex): MandateSpend {
  if (size(callData) !== 4 + 128 || slice(callData, 0, 4).toLowerCase() !== EXECUTE_USER_OP_SELECTOR) fail("invalid_call_data");
  const [mandateDigest, token, payee, amount] = decodeAbiParameters(spendParams, slice(callData, 4));
  return { mandateDigest, token, payee, amount };
}

/** Pack two uint128 values into a bytes32 (high | low). Values must fit in 128 bits. */
export function packUints(high: bigint, low: bigint): Hex {
  for (const v of [high, low]) if (v < 0n || v > uint128Max) fail("uint128_overflow");
  return pad(`0x${((high << 128n) | low).toString(16)}`, { size: 32 });
}
const unpackUints = (packed: Hex): [bigint, bigint] => {
  const v = BigInt(packed);
  return [v >> 128n, v & uint128Max];
};

export function buildMandateUserOp(input: MandateSpend & {
  account: Address;
  nonce: bigint;
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
}): PackedUserOp {
  const preVerificationGas = input.preVerificationGas ?? 60_000n;
  if (preVerificationGas < 0n || preVerificationGas > uint128Max) fail("uint128_overflow");
  return {
    sender: input.account,
    nonce: input.nonce,
    initCode: "0x",
    callData: encodeMandateSpendCall(input),
    accountGasLimits: packUints(input.verificationGasLimit ?? 300_000n, input.callGasLimit ?? 200_000n),
    preVerificationGas,
    gasFees: packUints(input.maxPriorityFeePerGas ?? 1_000_000_000n, input.maxFeePerGas ?? 2_000_000_000n),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** v0.7 prefund inputs exactly as the account derives them (no paymaster is accepted). */
export function userOpGas(op: PackedUserOp): { totalGasLimit: bigint; maxFeePerGas: bigint; maxGasCost: bigint } {
  if (op.paymasterAndData !== "0x") fail("paymaster_not_supported");
  if (op.preVerificationGas < 0n || op.preVerificationGas > uint128Max) fail("uint128_overflow");
  const [verificationGasLimit, callGasLimit] = unpackUints(op.accountGasLimits);
  const [, maxFeePerGas] = unpackUints(op.gasFees);
  const totalGasLimit = verificationGasLimit + callGasLimit + op.preVerificationGas;
  return { totalGasLimit, maxFeePerGas, maxGasCost: totalGasLimit * maxFeePerGas };
}

/** ERC-4337 v0.7 userOpHash: keccak256(abi.encode(keccak256(pack(op)), entryPoint, chainId)). */
export function userOperationHash(op: PackedUserOp, entryPoint: Address, chainId: number): Hex {
  assertTestnetChain(chainId);
  const packed = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
    [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits,
      op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)],
  );
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [keccak256(packed), entryPoint, BigInt(chainId)],
  ));
}

export interface GatekeeperDecision extends MandateSpend {
  chainId: number;
  account: Address;
  entryPoint: Address;
  userOpHash: Hex;
  nonce: bigint;
  totalGasLimit: bigint;
  maxFeePerGas: bigint;
  /** Unix seconds; required (0 would mean "no expiry" under ERC-4337 packing and is refused). */
  validUntil: number;
}

export const gatekeeperDecisionTypes = {
  GatekeeperDecision: [
    { name: "entryPoint", type: "address" },
    { name: "userOpHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "mandateDigest", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "totalGasLimit", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "validUntil", type: "uint48" },
  ],
} as const;

/**
 * Derive every co-signed field from the full op: decode callData, read gas fields, and RECOMPUTE the
 * userOpHash. This is the only supported way to build a decision for signing.
 */
export function gatekeeperDecisionFromUserOp(op: PackedUserOp, context: { chainId: number; entryPoint?: Address; validUntil: number }): GatekeeperDecision {
  const entryPoint = context.entryPoint ?? ENTRY_POINT_V07;
  if (op.initCode !== "0x") fail("init_code_not_supported");
  const spend = decodeMandateSpendCall(op.callData);
  const { totalGasLimit, maxFeePerGas } = userOpGas(op);
  return {
    ...spend, chainId: context.chainId, account: op.sender, entryPoint, userOpHash: userOperationHash(op, entryPoint, context.chainId),
    nonce: op.nonce, totalGasLimit, maxFeePerGas, validUntil: context.validUntil,
  };
}

export function gatekeeperDecisionTypedData(d: GatekeeperDecision) {
  assertTestnetChain(d.chainId);
  if (!Number.isSafeInteger(d.validUntil) || d.validUntil <= 0 || BigInt(d.validUntil) > uint48Max) fail("invalid_decision_expiry");
  const domain: TypedDataDomain = { name: "AttestMandateAccount", version: "1", chainId: d.chainId, verifyingContract: d.account };
  return {
    domain,
    types: gatekeeperDecisionTypes,
    primaryType: "GatekeeperDecision" as const,
    message: {
      entryPoint: d.entryPoint, userOpHash: d.userOpHash, nonce: d.nonce, mandateDigest: d.mandateDigest,
      token: d.token, payee: d.payee, amount: d.amount, totalGasLimit: d.totalGasLimit, maxFeePerGas: d.maxFeePerGas,
      validUntil: d.validUntil,
    },
  };
}

export const gatekeeperDecisionDigest = (d: GatekeeperDecision): Hex => hashTypedData(gatekeeperDecisionTypedData(d));

/** Minimal signer shapes satisfied by viem LocalAccount (privateKeyToAccount) or a remote signer. */
export interface SessionKeySigner { signMessage(args: { message: { raw: Hex } }): Promise<Hex> }
export interface GatekeeperSigner { signTypedData(args: ReturnType<typeof gatekeeperDecisionTypedData>): Promise<Hex> }
export interface ChainIdSource { getChainId(): Promise<number> }

/** Low-level: signs an already-derived decision. Prefer cosignMandateUserOp, which derives it from the op. */
export const signGatekeeperDecision = (signer: GatekeeperSigner, d: GatekeeperDecision): Promise<Hex> =>
  signer.signTypedData(gatekeeperDecisionTypedData(d));

/** Session key signs the userOpHash with the EIP-191 personal-message prefix. */
export const signSessionUserOp = (signer: SessionKeySigner, userOpHash: Hex): Promise<Hex> =>
  signer.signMessage({ message: { raw: userOpHash } });

/**
 * Gatekeeper co-signing entry point. Takes the FULL op (never a bare hash), checks the RPC chain id, derives the
 * decision from the op, lets the caller's policy inspect it (and the maximum gas cost), then signs.
 */
export async function cosignMandateUserOp(input: {
  op: PackedUserOp;
  chainId: number;
  client: ChainIdSource;
  entryPoint?: Address;
  validUntil: number;
  gatekeeper: GatekeeperSigner;
  approve?: (decision: GatekeeperDecision & { maxGasCost: bigint }) => boolean | Promise<boolean>;
}): Promise<{ signature: Hex; decision: GatekeeperDecision }> {
  await assertRpcChain(input.client, input.chainId);
  const decision = gatekeeperDecisionFromUserOp(input.op, {
    chainId: input.chainId, validUntil: input.validUntil, ...(input.entryPoint ? { entryPoint: input.entryPoint } : {}),
  });
  if (input.approve && !(await input.approve({ ...decision, maxGasCost: decision.totalGasLimit * decision.maxFeePerGas }))) fail("decision_denied");
  return { signature: await signGatekeeperDecision(input.gatekeeper, decision), decision };
}

export function encodeMandateSignature(decisionValidUntil: number, sessionSignature: Hex, gatekeeperSignature: Hex): Hex {
  return encodeAbiParameters([{ type: "uint48" }, { type: "bytes" }, { type: "bytes" }],
    [decisionValidUntil, sessionSignature, gatekeeperSignature]);
}

/**
 * Build, hash and 2-of-2 sign a mandate spend after checking the RPC chain id. In production the Gatekeeper
 * signature comes from Gatekeeper's decision API, which runs cosignMandateUserOp on the full op it receives.
 */
export async function signMandateUserOp(input: {
  op: PackedUserOp;
  chainId: number;
  client: ChainIdSource;
  entryPoint?: Address;
  decisionValidUntil: number;
  session: SessionKeySigner;
  gatekeeper: GatekeeperSigner;
}): Promise<{ op: PackedUserOp; userOpHash: Hex }> {
  const entryPoint = input.entryPoint ?? ENTRY_POINT_V07;
  const { signature, decision } = await cosignMandateUserOp({
    op: input.op, chainId: input.chainId, client: input.client, entryPoint, validUntil: input.decisionValidUntil, gatekeeper: input.gatekeeper,
  });
  const sessionSignature = await signSessionUserOp(input.session, decision.userOpHash);
  return { op: { ...input.op, signature: encodeMandateSignature(input.decisionValidUntil, sessionSignature, signature) }, userOpHash: decision.userOpHash };
}

/** Decode ERC-4337 validationData: sigFailed (aggregator == 1), validUntil (0 = forever) and validAfter. */
export function decodeValidationData(data: bigint) {
  const aggregator = data & ((1n << 160n) - 1n);
  const validUntil = Number((data >> 160n) & uint48Max);
  const validAfter = Number((data >> 208n) & uint48Max);
  return { sigFailed: aggregator === SIG_VALIDATION_FAILED, aggregator, validUntil: validUntil === 0 ? Number(uint48Max) : validUntil, validAfter };
}
