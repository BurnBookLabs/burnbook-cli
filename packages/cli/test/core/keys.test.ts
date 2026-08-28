import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import * as ed from "@noble/ed25519";
import { signedEnvelopeSchema, type SyncPayload } from "@burnbook/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureKeypair, signPayload } from "../../src/core/keys.js";

const ORIGINAL_CONFIG_DIR = process.env.BURNBOOK_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "burnbook-keys-"));
  process.env.BURNBOOK_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.BURNBOOK_CONFIG_DIR;
  } else {
    process.env.BURNBOOK_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const samplePayload: SyncPayload = {
  deviceId: "8f14e45f-ceea-467a-9575-2e2f3b6b6f0f",
  agent: "claude-code",
  sentAt: "2026-07-30T00:00:00.000Z",
  sessions: [
    {
      sessionId: "sess-a",
      messages: [
        {
          messageId: "msg_a1",
          requestId: "req_a1",
          ts: "2026-07-30T00:00:00.000Z",
          model: "claude-3",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    },
  ],
};

describe("keys", () => {
  it("generates a keypair once and persists it to key.json (mode 0600)", async () => {
    const first = await ensureKeypair();
    const second = await ensureKeypair();

    expect(second.keyId).toBe(first.keyId);
    expect(second.publicKeyB64).toBe(first.publicKeyB64);

    const keyFilePath = path.join(tmpDir, "key.json");
    const stat = await fs.stat(keyFilePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const dirStat = await fs.stat(tmpDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("returns a valid uuid keyId and a 32-byte public key", async () => {
    const { keyId, publicKeyB64 } = await ensureKeypair();

    expect(keyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(Buffer.from(publicKeyB64, "base64").length).toBe(32);
  });

  it("signs a payload such that the library's verify succeeds against the stored public key", async () => {
    const { keyId, publicKeyB64 } = await ensureKeypair();
    const envelope = await signPayload(samplePayload);

    expect(envelope.keyId).toBe(keyId);

    const payloadBytes = Buffer.from(envelope.payloadB64, "base64");
    const signatureBytes = Buffer.from(envelope.signatureB64, "base64");
    const publicKeyBytes = Buffer.from(publicKeyB64, "base64");

    expect(payloadBytes.toString("utf8")).toBe(JSON.stringify(samplePayload));

    const ok = await ed.verifyAsync(signatureBytes, payloadBytes, publicKeyBytes);
    expect(ok).toBe(true);
  });

  it("signature verifies with node:crypto's independent Ed25519 implementation", async () => {
    const { publicKeyB64 } = await ensureKeypair();
    const envelope = await signPayload(samplePayload);

    const message = Buffer.from(envelope.payloadB64, "base64");
    const signature = Buffer.from(envelope.signatureB64, "base64");
    const rawPubKey = Buffer.from(publicKeyB64, "base64");

    // RFC 8032 Ed25519 SPKI header
    const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
    const derPubKey = Buffer.concat([spkiHeader, rawPubKey]);

    const keyObject = createPublicKey({
      key: derPubKey,
      format: "der",
      type: "spki",
    });

    const verifyResult = verify(null, message, keyObject, signature);
    expect(verifyResult).toBe(true);
  });

  it("fails verification when payloadB64 bytes are tampered with", async () => {
    const { publicKeyB64 } = await ensureKeypair();
    const envelope = await signPayload(samplePayload);

    const payloadBytes = Buffer.from(envelope.payloadB64, "base64");
    payloadBytes[0] = payloadBytes[0]! ^ 0xff;

    const signatureBytes = Buffer.from(envelope.signatureB64, "base64");
    const publicKeyBytes = Buffer.from(publicKeyB64, "base64");

    const ok = await ed.verifyAsync(signatureBytes, payloadBytes, publicKeyBytes);
    expect(ok).toBe(false);
  });

  it("produces an envelope that parses with signedEnvelopeSchema", async () => {
    await ensureKeypair();
    const envelope = await signPayload(samplePayload);

    const result = signedEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it("refuses to load a symlinked private key", async () => {
    const sentinel = path.join(tmpDir, "sentinel");
    await fs.writeFile(sentinel, "{}", "utf8");
    await fs.symlink(sentinel, path.join(tmpDir, "key.json"));

    await expect(ensureKeypair()).rejects.toThrow();
  });
});
