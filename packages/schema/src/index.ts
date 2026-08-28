import { z } from "zod";


export const SCHEMA_PACKAGE_VERSION = "0.0.0";

export const MAX_MESSAGE_ID_LENGTH = 256;
export const MAX_REQUEST_ID_LENGTH = 256;
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_MODEL_ID_LENGTH = 128;
export const MAX_SOURCE_ID_LENGTH = 64;
export const MAX_CURSOR_NAMESPACE_LENGTH = 128;
export const ED25519_SIGNATURE_B64_LENGTH = 88;

/** Canonical preimage for legacy Claude/Codex event aliases. */
export function legacyEventIdentityInput(
  sessionId: string,
  messageId: string,
  requestId: string,
): string {
  return [sessionId, messageId, requestId].join("\x1f");
}

export const cursorNamespaceSchema = z.string()
  .min(1)
  .max(MAX_CURSOR_NAMESPACE_LENGTH)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/);

export const usageTupleSchema = z.object({
  messageId: z.string().min(1).max(MAX_MESSAGE_ID_LENGTH),
  requestId: z.string().min(1).max(MAX_REQUEST_ID_LENGTH),
  ts: z.string().datetime(),
  model: z.string().min(1).max(MAX_MODEL_ID_LENGTH),
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cacheReadTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cacheCreationTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const sessionSchema = z.object({
  sessionId: z.string().min(1).max(MAX_SESSION_ID_LENGTH),
  messages: z.array(usageTupleSchema).max(5000),
}).strict();

export const syncPayloadSchema = z.object({
  deviceId: z.string().uuid(),
  agent: z.literal("claude-code"),
  sentAt: z.string().datetime(),
  sessions: z.array(sessionSchema).max(200),
}).strict();

export const syncPayloadV1Schema = syncPayloadSchema;

export const MAX_ENVELOPE_PAYLOAD_B64_LENGTH = 16 * 1024 * 1024;

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function isCanonicalBase64(value: string): boolean {
  if (value.length > MAX_ENVELOPE_PAYLOAD_B64_LENGTH) return false;
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (base64Alphabet.indexOf(value[index]) === -1) return false;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== "=") return false;
  }
  if (padding === 2 && base64Alphabet.indexOf(value[dataLength - 1]) % 16 !== 0) return false;
  if (padding === 1 && base64Alphabet.indexOf(value[dataLength - 1]) % 4 !== 0) return false;
  return true;
}

export const signedEnvelopeSchema = z.object({
  payloadB64: z.string()
    .min(4)
    .max(MAX_ENVELOPE_PAYLOAD_B64_LENGTH)
    .refine(isCanonicalBase64, "payloadB64 must be canonical base64"),
  signatureB64: z.string()
    .length(ED25519_SIGNATURE_B64_LENGTH)
    .refine(isCanonicalBase64, "signatureB64 must encode a 64-byte Ed25519 signature"),
  keyId: z.string().uuid(),
}).strict();

const evidenceIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:+~-]*$/;
const versionIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Agent identifiers accepted by the Evidence V2 wire contract. */
export const agentIdSchema = z.enum([
  "claude-code",
  "codex",
  "antigravity",
  "gemini-cli",
  "cursor",
]);

/** The product surface on which an evidence event was observed. */
export const agentSurfaceSchema = z.enum([
  "cli",
  "desktop",
  "ide",
  "cloud",
  "team-api",
]);

/** The authoritative mechanism from which a collector read token usage. */
export const evidenceSourceSchema = z.enum([
  "hook",
  "transcript",
  "otel",
  "provider-api",
  "import",
]);

/** Provenance and attestation strength of the underlying usage evidence. */
export const evidenceClassSchema = z.enum([
  "agent-local",
  "official-telemetry",
  "provider-api",
]);

/** Product eligibility for an evidence record at the time it was collected. */
export const supportTierSchema = z.enum([
  "supported",
  "preview",
  "unsupported",
]);

export const trustTierSchema = z.enum([
  "device-attested",
  "provider-verified",
]);

export const evidenceTimeBasisSchema = z.enum(["provider", "collector"]);

export const evidenceIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(evidenceIdentifierPattern);

export const modelIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(evidenceIdentifierPattern);

export const evidenceVersionSchema = z.string()
  .min(1)
  .max(64)
  .regex(versionIdentifierPattern);

const tokenCountSchema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** Content-free usage whose disjoint counters reconcile to totalTokens. */
export const usageEvidenceV2Schema = z.object({
  schemaVersion: z.literal(2),
  agent: agentIdSchema,
  surface: agentSurfaceSchema,
  source: evidenceSourceSchema,
  sourceVersion: evidenceVersionSchema,
  collectorVersion: evidenceVersionSchema,
  normalizerVersion: z.number().int().positive().max(65535),
  evidenceClass: evidenceClassSchema,
  supportTier: supportTierSchema,
  eventId: evidenceIdentifierSchema,
  sessionId: evidenceIdentifierSchema.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  timeBasis: evidenceTimeBasisSchema,
  model: modelIdentifierSchema,
  agentVersion: evidenceVersionSchema.optional(),
  inputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  reasoningTokens: tokenCountSchema,
  toolInputTokens: tokenCountSchema,
  totalTokens: tokenCountSchema,
}).strict().superRefine((evidence, context) => {
  const normalizedTotal = evidence.inputTokens
    + evidence.cacheReadTokens
    + evidence.cacheWriteTokens
    + evidence.outputTokens
    + evidence.reasoningTokens
    + evidence.toolInputTokens;

  if (normalizedTotal !== evidence.totalTokens) {
    context.addIssue({
      code: "custom",
      path: ["totalTokens"],
      message: "totalTokens must equal the sum of normalized token counters",
    });
  }
});

/** A signed-upload payload containing only Evidence V2 usage records. */
export const syncPayloadV2Schema = z.object({
  schemaVersion: z.literal(2),
  clientVersion: evidenceVersionSchema.optional(),
  deviceId: z.string().uuid(),
  sentAt: z.string().datetime({ offset: true }),
  evidence: z.array(usageEvidenceV2Schema).max(5000),
}).strict();

/** Per-event acknowledgement for a single-agent/surface V2 upload batch. */
export const syncResponseV2Schema = z.object({
  acceptedEventIds: z.array(evidenceIdentifierSchema).max(5000),
  duplicateEventIds: z.array(evidenceIdentifierSchema).max(5000),
}).strict();

const decimalTokenPattern = /^(0|[1-9][0-9]{0,29})$/;

export const decimalTokenCountSchema = z.union([
  tokenCountSchema,
  z.string().regex(decimalTokenPattern),
]);

export const usageEvidenceV3Schema = z.object({
  schemaVersion: z.literal(3),
  agent: agentIdSchema,
  surface: agentSurfaceSchema,
  source: evidenceSourceSchema,
  sourceVersion: evidenceVersionSchema,
  collectorVersion: evidenceVersionSchema,
  normalizerVersion: z.number().int().positive().max(65535),
  evidenceClass: evidenceClassSchema,
  supportTier: supportTierSchema,
  eventId: evidenceIdentifierSchema,
  sessionId: evidenceIdentifierSchema.optional(),
  projectId: z.string().uuid().optional(),
  occurredAt: z.string().datetime({ offset: true }),
  timeBasis: evidenceTimeBasisSchema,
  model: modelIdentifierSchema,
  agentVersion: evidenceVersionSchema.optional(),
  inputTokens: decimalTokenCountSchema,
  cacheReadTokens: decimalTokenCountSchema,
  cacheWriteTokens: decimalTokenCountSchema,
  outputTokens: decimalTokenCountSchema,
  reasoningTokens: decimalTokenCountSchema,
  toolInputTokens: decimalTokenCountSchema,
  totalTokens: decimalTokenCountSchema,
}).strict().superRefine((evidence, context) => {
  const normalizedTotal = [
    evidence.inputTokens,
    evidence.cacheReadTokens,
    evidence.cacheWriteTokens,
    evidence.outputTokens,
    evidence.reasoningTokens,
    evidence.toolInputTokens,
  ].reduce((total, value) => total + BigInt(value), 0n);

  if (normalizedTotal !== BigInt(evidence.totalTokens)) {
    context.addIssue({
      code: "custom",
      path: ["totalTokens"],
      message: "totalTokens must equal the sum of normalized token counters",
    });
  }
});

export const syncPayloadV3Schema = z.object({
  schemaVersion: z.literal(3),
  clientVersion: evidenceVersionSchema.optional(),
  deviceId: z.string().uuid(),
  sentAt: z.string().datetime({ offset: true }),
  evidence: z.array(usageEvidenceV3Schema).max(5000),
}).strict();

export const syncResponseV3Schema = syncResponseV2Schema;

export const tokenTotalsSchema = z.object({
  processedTokens: z.string().regex(decimalTokenPattern),
  freshTokens: z.string().regex(decimalTokenPattern),
  inputTokens: z.string().regex(decimalTokenPattern),
  cacheReadTokens: z.string().regex(decimalTokenPattern),
  cacheWriteTokens: z.string().regex(decimalTokenPattern),
  outputTokens: z.string().regex(decimalTokenPattern),
  reasoningTokens: z.string().regex(decimalTokenPattern),
  toolInputTokens: z.string().regex(decimalTokenPattern),
  cacheHitRate: z.number().min(0).max(1).nullable(),
}).strict();

// Inferred TS types
export type UsageTuple = z.infer<typeof usageTupleSchema>;
export type SyncPayload = z.infer<typeof syncPayloadSchema>;
export type SyncPayloadV1 = SyncPayload;
export type SignedEnvelope = z.infer<typeof signedEnvelopeSchema>;
export type AgentId = z.infer<typeof agentIdSchema>;
export type AgentSurface = z.infer<typeof agentSurfaceSchema>;
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceClass = z.infer<typeof evidenceClassSchema>;
export type SupportTier = z.infer<typeof supportTierSchema>;
export type TrustTier = z.infer<typeof trustTierSchema>;
export type EvidenceTimeBasis = z.infer<typeof evidenceTimeBasisSchema>;
export type UsageEvidenceV2 = z.infer<typeof usageEvidenceV2Schema>;
export type SyncPayloadV2 = z.infer<typeof syncPayloadV2Schema>;
export type SyncResponseV2 = z.infer<typeof syncResponseV2Schema>;
export type UsageEvidenceV3 = z.infer<typeof usageEvidenceV3Schema>;
export type SyncPayloadV3 = z.infer<typeof syncPayloadV3Schema>;
export type SyncResponseV3 = z.infer<typeof syncResponseV3Schema>;
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;

export const AGENT_COMPATIBILITY_REGISTRY_VERSION = 1 as const;

export const agentCompatibilityEntrySchema = z.object({
  agent: agentIdSchema,
  displayName: z.string().min(1).max(64),
  supportTier: supportTierSchema,
  rankEligible: z.boolean(),
  surface: agentSurfaceSchema,
  source: evidenceSourceSchema,
  sourceVersion: evidenceVersionSchema,
  collectorVersion: evidenceVersionSchema,
  normalizerVersion: z.number().int().positive().max(65535),
  evidenceClass: evidenceClassSchema,
  testedAgentVersions: z.string().min(1).max(128),
  capabilities: z.object({
    tokens: z.boolean(),
    sessions: z.boolean(),
    cache: z.boolean(),
    models: z.boolean(),
  }).strict(),
  coverage: z.string().min(1).max(512),
  certification: z.object({
    status: z.enum(["certified", "preview", "uncertified"]),
    suite: evidenceVersionSchema,
  }).strict(),
}).strict();

export const agentCompatibilityRegistrySchema = z.object({
  registryVersion: z.literal(AGENT_COMPATIBILITY_REGISTRY_VERSION),
  evidenceSchemaVersion: z.literal(2),
  agents: z.array(agentCompatibilityEntrySchema).min(1),
}).strict().superRefine((registry, context) => {
  const identities = new Set<string>();
  for (const [index, entry] of registry.agents.entries()) {
    const identity = `${entry.agent}:${entry.surface}:${entry.source}`;
    if (identities.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["agents", index],
        message: "collector compatibility identities must be unique",
      });
    }
    identities.add(identity);
    if (entry.rankEligible && entry.supportTier !== "supported") {
      context.addIssue({
        code: "custom",
        path: ["agents", index, "rankEligible"],
        message: "only supported evidence may be rank eligible",
      });
    }
  }
});

export type AgentCompatibilityEntry = z.infer<typeof agentCompatibilityEntrySchema>;
export type AgentCompatibilityRegistry = z.infer<typeof agentCompatibilityRegistrySchema>;

/** Authoritative, versioned product support contract for CLI, web, and API surfaces. */
export const agentCompatibilityRegistry = {
  registryVersion: AGENT_COMPATIBILITY_REGISTRY_VERSION,
  evidenceSchemaVersion: 2,
  agents: [
    {
      agent: "claude-code",
      displayName: "Claude Code",
      supportTier: "supported",
      rankEligible: true,
      surface: "cli",
      source: "transcript",
      sourceVersion: "claude-transcript-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "agent-local",
      testedAgentVersions: "current local transcript schema",
      capabilities: { tokens: true, sessions: true, cache: true, models: true },
      coverage: "Persisted local Claude Code sessions; ephemeral or deleted sessions are not covered.",
      certification: { status: "certified", suite: "claude-code-v1" },
    },
    {
      agent: "codex",
      displayName: "Codex",
      supportTier: "preview",
      rankEligible: false,
      surface: "cli",
      source: "transcript",
      sourceVersion: "codex-rollout-token-count-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "agent-local",
      testedAgentVersions: "local rollout token_count schema",
      capabilities: { tokens: true, sessions: true, cache: true, models: true },
      coverage: "Persisted local rollouts only; ephemeral and cloud-only sessions are not covered.",
      certification: { status: "preview", suite: "codex-privacy-v1" },
    },
    {
      agent: "gemini-cli",
      displayName: "Gemini CLI",
      supportTier: "preview",
      rankEligible: false,
      surface: "cli",
      source: "otel",
      sourceVersion: "gemini-otel-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "official-telemetry",
      testedAgentVersions: "official local OpenTelemetry token metrics",
      capabilities: { tokens: true, sessions: true, cache: true, models: true },
      coverage: "Local token telemetry with prompt logging disabled.",
      certification: { status: "preview", suite: "gemini-cli-otel-v1" },
    },
    {
      agent: "cursor",
      displayName: "Cursor",
      supportTier: "preview",
      rankEligible: false,
      surface: "ide",
      source: "import",
      sourceVersion: "burnbook-import-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "agent-local",
      testedAgentVersions: "content-free import contract",
      capabilities: { tokens: true, sessions: true, cache: true, models: true },
      coverage: "User-supplied content-free usage exports only.",
      certification: { status: "preview", suite: "content-free-import-v1" },
    },
    {
      agent: "antigravity",
      displayName: "Antigravity",
      supportTier: "preview",
      rankEligible: false,
      surface: "ide",
      source: "import",
      sourceVersion: "burnbook-import-v1",
      collectorVersion: "1",
      normalizerVersion: 1,
      evidenceClass: "agent-local",
      testedAgentVersions: "content-free import contract",
      capabilities: { tokens: true, sessions: true, cache: true, models: true },
      coverage: "User-supplied content-free usage exports only.",
      certification: { status: "preview", suite: "content-free-import-v1" },
    },
  ] as const,
} as const satisfies AgentCompatibilityRegistry;

/** Backward-compatible manifest view; do not define support claims elsewhere. */
export const agentSupportManifest = agentCompatibilityRegistry.agents;

type CompatibilityIdentity = Pick<
  UsageEvidenceV2,
  | "agent"
  | "surface"
  | "source"
  | "sourceVersion"
  | "collectorVersion"
  | "normalizerVersion"
  | "evidenceClass"
  | "supportTier"
>;

/** Exact adapter compatibility check shared by collectors and ingestion. */
export function isEvidenceCompatibleWithManifest(evidence: CompatibilityIdentity): boolean {
  return agentSupportManifest.some((entry) =>
    entry.agent === evidence.agent &&
    entry.surface === evidence.surface &&
    entry.source === evidence.source &&
    entry.sourceVersion === evidence.sourceVersion &&
    entry.collectorVersion === evidence.collectorVersion &&
    entry.normalizerVersion === evidence.normalizerVersion &&
    entry.evidenceClass === evidence.evidenceClass &&
    entry.supportTier === evidence.supportTier,
  );
}
