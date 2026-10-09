/** Portable encrypted custody. No evidence or passphrase is sent to a server. */
export type VaultEnvelope = {
  version: 1;
  namespace: string;
  kdf: "PBKDF2-SHA256";
  iterations: 310000;
  salt: string;
  iv: string;
  ciphertext: string;
};
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
function decode(value: string) {
  if (value.length > 12_000_000) throw new Error("Vault exceeds size limit");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function derive(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  if (passphrase.length < 12)
    throw new Error("Use a vault passphrase of at least 12 characters");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptVault(
  value: unknown,
  passphrase: string,
  namespace: string,
): Promise<VaultEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.byteLength > 8_000_000)
    throw new Error("Vault exceeds 8 MB limit");
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(namespace),
    },
    await derive(passphrase, salt),
    plaintext,
  );
  return {
    version: 1,
    namespace,
    kdf: "PBKDF2-SHA256",
    iterations: 310000,
    salt: encode(salt),
    iv: encode(iv),
    ciphertext: encode(new Uint8Array(ciphertext)),
  };
}
export async function decryptVault(
  input: unknown,
  passphrase: string,
  namespace: string,
): Promise<unknown> {
  if (!input || typeof input !== "object") throw new Error("Invalid vault");
  const e = input as VaultEnvelope;
  if (
    e.version !== 1 ||
    e.namespace !== namespace ||
    e.kdf !== "PBKDF2-SHA256" ||
    e.iterations !== 310000 ||
    typeof e.salt !== "string" ||
    typeof e.iv !== "string" ||
    typeof e.ciphertext !== "string"
  )
    throw new Error("Vault format, account or network does not match");
  const salt = decode(e.salt),
    iv = decode(e.iv);
  if (salt.length !== 16 || iv.length !== 12)
    throw new Error("Invalid vault parameters");
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(namespace),
    },
    await derive(passphrase, salt),
    decode(e.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(clear));
}
