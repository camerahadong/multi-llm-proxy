export type BackendName = 'claude' | 'codex' | 'gemini';

export interface CallInput {
  userPrompt: string;
  systemPrompt?: string;
  /** Tmp file paths of attached images (already saved by image-store). */
  imagePaths?: string[];
  model: string;
  /** Allow built-in CLI tools (e.g. Read for vision). */
  visionMode?: boolean;
  /** Enable Claude `--think` flag. */
  thinking?: boolean;
  timeoutMs: number;
}

export interface CallResult {
  content: string;
  cost: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  durationMs: number;
}

export interface PoolStats {
  status: 'ok' | 'error' | 'limited' | 'unknown';
  poolSize: number;
  inFlight: number;
  queueDepth: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  lastErrorTs: number | null;
  lastErrorMessage: string | null;
  checkedAt: string | null;
}

export interface BackendAdapter {
  readonly name: BackendName;
  call(input: CallInput, signal: AbortSignal): Promise<CallResult>;
  stats(): PoolStats;
  healthCheck(): Promise<PoolStats>;
  shutdown(): Promise<void>;
}
