/**
 * At-rest encryption for Command Code API keys.
 *
 * AES-256-GCM with a key derived from the configured secret (raw UTF-8 or base64:
 * prefixed 32-byte key). Format: "v1.<b64 iv>.<b64 tag>.<b64 ciphertext>".
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "v1.";

export function deriveCommandCodeKey(secret: string): Buffer {
  if (!secret || secret.length === 0) {
    throw new Error("COMMANDCODE_ENC_KEY must be a non-empty secret.");
  }
  if (secret.startsWith("base64:")) {
    const decoded = Buffer.from(secret.slice("base64:".length).trim(), "base64");
    if (decoded.length !== 32) throw new Error("COMMANDCODE_ENC_KEY (base64:) must decode to exactly 32 bytes.");
    return decoded;
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("COMMANDCODE_ENC_KEY must be at least 32 bytes (raw) or base64: prefixed 32-byte key.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (!plaintext) throw new Error("Cannot encrypt an empty secret.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (!payload.startsWith(PREFIX)) throw new Error("Unsupported or corrupt encrypted secret payload.");
  const [marker, ivB64, tagB64, cipherB64] = payload.split(".");
  if (marker !== "v1" || !ivB64 || !tagB64 || !cipherB64) throw new Error("Corrupt encrypted secret payload.");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(cipherB64, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Corrupt encrypted secret payload (bad iv/tag length).");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
