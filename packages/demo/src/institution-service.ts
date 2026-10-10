import { z } from "zod";
import { canonicalJson } from "@attest/core";
import { institutionDirectory, journeyProfile } from "./testnet-journey";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());
export const institutionCommandSchema = z
  .object({
    version: z.literal(2),
    chainId: z.literal(11155111),
    profile: z.literal(journeyProfile),
    domain: z.literal("attest.gmac.io"),
    action: z.enum(["issue", "revoke"]),
    account: address,
    registry: address,
    journey: z.string().uuid(),
    holderPublicKey: z.string().min(20).max(100),
    institution: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    value: z.number().int().nonnegative().max(10000000),
    validThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expiresAt: z.string().datetime(),
    nonce: z.string().uuid(),
    demoConsent: z.literal(true),
  })
  .strict();
export type InstitutionCommand = z.infer<typeof institutionCommandSchema>;
export const commandMessage = (command: InstitutionCommand) =>
  `Attest Sepolia fictional institution request\n${institutionDirectory.institutions[command.institution]!.name}\n${command.action === "issue" ? "Issue a synthetic credential and sponsor its registration" : "Revoke this journey’s synthetic credential permanently"}\nNo transfer of your funds. No real-world credential.\n${canonicalJson(command)}`;
