import type { UsageEvidenceV2 } from "@burnbook/schema";
import type { JsonlByteCursor } from "../core/jsonl-tail.js";

export type AgentId = UsageEvidenceV2["agent"];
export type CollectionCursor = number | JsonlByteCursor;

export type CollectorStatus =
  | "active"
  | "available"
  | "degraded"
  | "unavailable";

export interface DetectionResult {
  status: CollectorStatus;
  detail: string;
}

export interface CollectionInput {
  root?: string;
  afterLine?: CollectionCursor;
}

export interface CollectionResult {
  evidence: UsageEvidenceV2[];
  lastLine: number;
  cursor?: CollectionCursor;
  byteCursor?: JsonlByteCursor;
  diagnostics: string[];
}

export interface CollectionLimits {
  maxEvidence: number;
  maxLines: number;
}

export interface AgentCollector {
  readonly agent: AgentId;
  readonly surface: UsageEvidenceV2["surface"];
  readonly source: UsageEvidenceV2["source"];
  detect(input?: CollectionInput): Promise<DetectionResult>;
  collect(input?: CollectionInput): Promise<CollectionResult>;
  discoverResources(input?: CollectionInput): Promise<string[]>;
  collectResource(
    resource: string,
    cursor: CollectionCursor,
    limits?: CollectionLimits,
  ): Promise<CollectionResult>;
}
