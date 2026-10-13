/**
 * Fictional, deterministic token-education story for the Attest browser demos.
 *
 * This model has NO chain effects, no actual credentials and no authorization
 * logic. Keep it independent of UI animations so invariants can be tested.
 */
export type TokenProofPath = "bridge" | "native";

export const tokenScenes = [
  {
    id: "claim",
    label: "Private claim",
    title: "An issuer signs a claim.",
    explanation: "An authorized issuer signs a credential about the holder. The signed POD and the underlying evidence remain private; a claim is not automatically an NFT.",
    publicText: "Nothing about the underlying evidence needs to be published.",
    privateText: "Issuer-signed POD, exact score, holder and evidence",
  },
  {
    id: "nft",
    label: "Claim NFT",
    title: "A public Claim NFT is optional.",
    explanation: "The holder can opt into a non-transferable ERC-721 containing a public commitment. The NFT is a pointer to a claim, not the original private credential and not transferable expertise.",
    publicText: "Optional Claim NFT: commitment, issuer, subject address and status",
    privateText: "Signed evidence and undisclosed claim values",
  },
  {
    id: "proof",
    label: "Private proof",
    title: "Prove eligibility, not the secret.",
    explanation: "The holder demonstrates a defined requirement without publishing the private score or evidence. Who verifies the proof matters to the conversion path.",
    publicText: "A specific requirement and permitted proof outputs",
    privateText: "Signed claim, witness and hidden qualifying score",
  },
  {
    id: "mint",
    label: "Convert",
    title: "One eligible claim releases test $ATTEST.",
    explanation: "The fixed conversion policy authorizes 200 fictional units. The same claim's redemption entitlement is consumed once; the original credential remains available for later proofs.",
    publicText: "Recipient, policy, amount, mint event and spend-once nullifier",
    privateText: "Claim content, score, event secret and private proof inputs",
  },
  {
    id: "transfer",
    label: "Transfer",
    title: "Tokens move. Qualifications do not.",
    explanation: "Alice transfers 50 of her simulated $ATTEST to Bob. The proportional four-color economic provenance mixes with Bob's existing holdings, but Bob does not acquire Alice's credentials.",
    publicText: "ERC-20 balances, transfer event and economic composition",
    privateText: "Alice's original claim and private qualification",
  },
  {
    id: "passport",
    label: "Living artwork",
    title: "The economic passport changes with holdings.",
    explanation: "A separate, opt-in, non-transferable ERC-721 renders each wallet's live $ATTEST balance and aggregate provenance colors. The image depicts economic holdings, not an objective trust score.",
    publicText: "Wallet's ERC-20 holdings and dynamic ERC-721 artwork",
    privateText: "The credential that originally authorized issuance",
  },
  {
    id: "revoked",
    label: "Revocation",
    title: "Revocation blocks new conversion, not history.",
    explanation: "An issuer can revoke the claim. A revoked claim must not authorize fresh issuance. Previously minted $ATTEST remains transferable unless an explicit token policy says otherwise.",
    publicText: "Updated public claim status; already minted supply remains",
    privateText: "Revoked evidence record stays available for historical inspection",
  },
] as const;

export type TokenSceneId = (typeof tokenScenes)[number]["id"];
export type TokenComposition = readonly [number, number, number, number];
export type TokenWallet = Readonly<{
  amount: number;
  composition: TokenComposition;
}>;
export type TokenStoryFrame = Readonly<{
  scene: TokenSceneId;
  path: TokenProofPath;
  claimNftVisible: boolean;
  claimRevoked: boolean;
  privateProofPrepared: boolean;
  issuanceRecorded: boolean;
  entitlementSpent: boolean;
  passportVisible: boolean;
  transferRecorded: boolean;
  alice: TokenWallet;
  bob: TokenWallet;
}>;

const EMPTY: TokenWallet = { amount: 0, composition: [0, 0, 0, 0] };
const MINTED: TokenWallet = { amount: 200, composition: [100, 50, 30, 20] };
const BOB_EXISTING: TokenWallet = { amount: 80, composition: [0, 0, 80, 0] };
const ALICE_AFTER: TokenWallet = { amount: 150, composition: [75, 37.5, 22.5, 15] };
const BOB_AFTER: TokenWallet = { amount: 130, composition: [25, 12.5, 87.5, 5] };

export function getTokenStoryFrame(index: number, path: TokenProofPath = "bridge"): TokenStoryFrame {
  if (!Number.isInteger(index) || index < 0 || index >= tokenScenes.length)
    throw new RangeError("Unknown token story scene");
  if (path !== "bridge" && path !== "native") throw new Error("Unknown proof path");

  const issuanceRecorded = index >= 3;
  const transferRecorded = index >= 4;
  return {
    scene: tokenScenes[index]!.id,
    path,
    claimNftVisible: index >= 1,
    claimRevoked: index === tokenScenes.length - 1,
    privateProofPrepared: index >= 2,
    issuanceRecorded,
    entitlementSpent: issuanceRecorded,
    passportVisible: index >= 5,
    transferRecorded,
    alice: !issuanceRecorded ? EMPTY : transferRecorded ? ALICE_AFTER : MINTED,
    bob: !issuanceRecorded ? EMPTY : transferRecorded ? BOB_AFTER : BOB_EXISTING,
  };
}

export function assertTokenComposition(wallet: TokenWallet): boolean {
  return Number.isFinite(wallet.amount) &&
    wallet.amount >= 0 &&
    wallet.composition.every((n) => Number.isFinite(n) && n >= 0) &&
    Math.abs(wallet.composition.reduce((n, v) => n + v, 0) - wallet.amount) < 0.0000001;
}
