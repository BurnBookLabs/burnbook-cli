import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as ed from "@noble/ed25519";
import {
  signedEnvelopeSchema,
  type SignedEnvelope,
  type SyncPayload,
  type SyncPayloadV2,
  type SyncPayloadV3,
} from "@burnbook/schema";
import { z } from "zod";
import { configDir } from "./paths.js";
import { readPrivateFile, writePrivateFile } from "./private-files.js";

/* On-disk shape of `<configDir>/key.json`. */
interface KeyFile {
  keyId: string;
  privateKeyB64: string;
  publicKeyB64: string;
}

const keyFileSchema = z.object({
  keyId: z.string().uuid(),
  privateKeyB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  publicKeyB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
}).strict().refine((value) => Buffer.from(value.privateKeyB64, "base64").length === 32)
  .refine((value) => Buffer.from(value.publicKeyB64, "base64").length === 32);

function keyFilePath(): string {
  return path.join(configDir(), "key.json");
}

async function loadKeyFile(): Promise<KeyFile | undefined> {
  const raw = await readPrivateFile(keyFilePath());
  if (raw === undefined) return undefined;
  return keyFileSchema.parse(JSON.parse(raw));
}

/* Persist the key file to `<config dir>/key.json`. */
async function saveKeyFile(key: KeyFile): Promise<void> {
  await writePrivateFile(keyFilePath(), `${JSON.stringify(keyFileSchema.parse(key), null, 2)}\n`);
}

/* Load the device keypair, generating and persisting one on first use. */
async function ensureKeyFile(): Promise<KeyFile> {
  const existing = await loadKeyFile();
  if (existing) {
    return existing;
  }

  const { secretKey, publicKey } = await ed.keygenAsync();
  const key: KeyFile = {
    keyId: randomUUID(),
    privateKeyB64: Buffer.from(secretKey).toString("base64"),
    publicKeyB64: Buffer.from(publicKey).toString("base64"),
  };
  await saveKeyFile(key);
  return key;
}

export async function ensureKeypair(): Promise<{ keyId: string; publicKeyB64: string }> {
  const { keyId, publicKeyB64 } = await ensureKeyFile();
  return { keyId, publicKeyB64 };
}

/* Sign a sync payload with the device private key. */
export async function signPayload(payload: SyncPayload | SyncPayloadV2 | SyncPayloadV3): Promise<SignedEnvelope> {
  const key = await ensureKeyFile();
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const secretKey = Buffer.from(key.privateKeyB64, "base64");
  const signature = await ed.signAsync(payloadBytes, secretKey);

  return signedEnvelopeSchema.parse({
    payloadB64: Buffer.from(payloadBytes).toString("base64"),
    signatureB64: Buffer.from(signature).toString("base64"),
    keyId: key.keyId,
  });
}
