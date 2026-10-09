// Worker-only adapter: pinned public verification keys from GPC artifacts 0.13.0.
import key0 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_1o-10e-5md-0nv-0ei-0x0l-0x0t-0ov3-1ov4-vkey.json";
import key1 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_1o-11e-5md-0nv-0ei-0x0l-0x0t-0ov3-1ov4-vkey.json";
import key2 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_1o-11e-5md-0nv-0ei-1x200l-1x3t-0ov3-1ov4-vkey.json";
import key3 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_1o-11e-5md-0nv-0ei-1x50l-1x3t-0ov3-1ov4-vkey.json";
import key4 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_1o-12e-5md-4nv-0ei-1x5l-0x0t-0ov3-1ov4-vkey.json";
import key5 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_1o-1e-5md-0nv-0ei-0x0l-0x0t-0ov3-1ov4-vkey.json";
import key6 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_1o-5e-6md-2nv-0ei-0x0l-0x0t-1ov3-1ov4-vkey.json";
import key7 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_3o-10e-8md-4nv-2ei-2x20l-2x2t-0ov3-1ov4-vkey.json";
import key8 from "../../../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts/proto-pod-gpc_3o-10e-8md-4nv-2ei-4x20l-5x3t-1ov3-1ov4-vkey.json";
const keys: Record<string, unknown> = {
  "proto-pod-gpc_1o-10e-5md-0nv-0ei-0x0l-0x0t-0ov3-1ov4-vkey.json": key0,
  "proto-pod-gpc_1o-11e-5md-0nv-0ei-0x0l-0x0t-0ov3-1ov4-vkey.json": key1,
  "proto-pod-gpc_1o-11e-5md-0nv-0ei-1x200l-1x3t-0ov3-1ov4-vkey.json": key2,
  "proto-pod-gpc_1o-11e-5md-0nv-0ei-1x50l-1x3t-0ov3-1ov4-vkey.json": key3,
  "proto-pod-gpc_1o-12e-5md-4nv-0ei-1x5l-0x0t-0ov3-1ov4-vkey.json": key4,
  "proto-pod-gpc_1o-1e-5md-0nv-0ei-0x0l-0x0t-0ov3-1ov4-vkey.json": key5,
  "proto-pod-gpc_1o-5e-6md-2nv-0ei-0x0l-0x0t-1ov3-1ov4-vkey.json": key6,
  "proto-pod-gpc_3o-10e-8md-4nv-2ei-2x20l-2x2t-0ov3-1ov4-vkey.json": key7,
  "proto-pod-gpc_3o-10e-8md-4nv-2ei-4x20l-5x3t-1ov3-1ov4-vkey.json": key8,
};
export async function readExisting(url: string) {
  const root =
    "https://cdn.jsdelivr.net/npm/@pcd/proto-pod-gpc-artifacts@0.13.0/";
  if (typeof url !== "string" || !url.startsWith(root))
    throw new Error("Unsupported verification artifact source");
  const key = keys[url.slice(root.length)];
  if (!key) throw new Error("Unknown verification circuit");
  const bytes = new TextEncoder().encode(JSON.stringify(key));
  return {
    totalSize: bytes.length,
    read: async () => bytes,
    close: async () => {},
  };
}
