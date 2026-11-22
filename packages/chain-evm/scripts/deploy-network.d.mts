import type { Address, EIP1193Provider, Hex } from "viem";

export declare const deployedContracts: readonly ["WorkspaceRegistry", "DecisionLogAnchor"];
export interface DeploymentManifest {
  version: 1;
  network: string;
  chainId: number;
  deployer: Address;
  contracts: Record<"WorkspaceRegistry" | "DecisionLogAnchor", { default: Address }>;
  transactions: Record<"WorkspaceRegistry" | "DecisionLogAnchor", { hash: Hex; blockNumber: string; administrator: Address }>;
}
export declare function deployNetwork(options: {
  network: string;
  provider?: EIP1193Provider;
  privateKey?: Hex;
  rpcUrl?: string;
  administrator?: string;
  confirmations?: number;
  log?: (message: string) => void;
}): Promise<DeploymentManifest>;
