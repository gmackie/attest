/** Worker-only Groth16 verification adapter. Mirrors snarkjs's pairing equation,
 * using noble's BN254 arithmetic because snarkjs's browser worker/WASM loader
 * cannot run in Cloudflare Workers. No proving implementation is shipped here.
 */
import { bn254 } from "@noble/curves/bn254";
const integer = (v: unknown) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d{1,80}$/.test(v)) return BigInt(v);
  throw new Error("Invalid field encoding");
};
const field = (v: unknown) => {
  const n = integer(v);
  if (n < 0n || n >= bn254.fields.Fp.ORDER)
    throw new Error("Noncanonical field element");
  return n;
};
const g1 = (v: unknown) => {
  if (!Array.isArray(v) || v.length !== 3 || integer(v[2]) !== 1n)
    throw new Error("Invalid affine G1");
  const p = bn254.G1.Point.fromAffine({ x: field(v[0]), y: field(v[1]) });
  p.assertValidity();
  return p;
};
const fp2 = (v: unknown) => {
  if (!Array.isArray(v) || v.length !== 2) throw new Error("Invalid Fp2");
  return { c0: field(v[0]), c1: field(v[1]) };
};
const g2 = (v: unknown) => {
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    !Array.isArray(v[2]) ||
    integer(v[2][0]) !== 1n ||
    integer(v[2][1]) !== 0n
  )
    throw new Error("Invalid affine G2");
  const p = bn254.G2.Point.fromAffine({ x: fp2(v[0]), y: fp2(v[1]) });
  p.assertValidity();
  return p;
};
export const groth16 = {
  async verify(
    vk: Record<string, unknown>,
    signals: unknown[],
    proof: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      if (
        vk.protocol !== "groth16" ||
        vk.curve !== "bn128" ||
        proof.protocol !== "groth16" ||
        proof.curve !== "bn128" ||
        !Array.isArray(vk.IC) ||
        vk.IC.length !== signals.length + 1 ||
        vk.nPublic !== signals.length ||
        signals.length > 10000
      )
        return false;
      let sum = g1(vk.IC[0]);
      for (let i = 0; i < signals.length; i++) {
        const scalar = integer(signals[i]);
        if (scalar < 0n || scalar >= bn254.fields.Fr.ORDER) return false;
        const point = g1(vk.IC[i + 1]);
        if (scalar !== 0n) sum = sum.add(point.multiply(scalar));
      }
      const result = bn254.pairingBatch([
        { g1: g1(proof.pi_a).negate(), g2: g2(proof.pi_b) },
        { g1: sum, g2: g2(vk.vk_gamma_2) },
        { g1: g1(proof.pi_c), g2: g2(vk.vk_delta_2) },
        { g1: g1(vk.vk_alpha_1), g2: g2(vk.vk_beta_2) },
      ]);
      return bn254.fields.Fp12.eql(result, bn254.fields.Fp12.ONE);
    } catch {
      return false;
    }
  },
  async fullProve(): Promise<never> {
    throw new Error(
      "Private proving belongs in the user wallet, never this service",
    );
  },
};
