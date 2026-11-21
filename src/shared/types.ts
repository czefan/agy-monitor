export type ContextLevel = 'ok' | 'warn' | 'danger';

export interface ContextGroupItem {
  name: string;
  type: string;
  tokens: number;
}

export interface HeavyConsumerItem {
  stepIndex: number | null;
  label: string;
  tokens: number;
  pct: number;
}

export interface TurnSummary {
  index: number;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  responseTokens: number;
  cacheHitPct: number | null;
  ttftSec: number | null;
  streamSec: number | null;
  tps: number | null;
  contextUsed: number;
  contextLimit: number;
  contextPct: number;
  costUsd: number | null;
}

export interface SubagentItem {
  conversationId: string;
  role: string;
  typeName: string;
  model: string;
  turnsCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  avgTps: number | null;
}

export interface SubagentSummary {
  count: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  items: SubagentItem[];
}

export interface TelemetryContext {
  used: number;
  limit: number;
  pct: number;
  level: ContextLevel;
  checkpointCount: number;
  groups: ContextGroupItem[];
  heavyConsumers: HeavyConsumerItem[];
}

export interface TelemetryLatest {
  tps: number | null;
  ttftSec: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  responseTokens: number;
  cacheHitPct: number | null;
  costUsd: number | null;
}

export interface TelemetrySession {
  turnsCount: number;
  avgTps: number | null;
  medianTtftSec: number | null;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalResponseTokens: number;
  cacheHitPct: number | null;
  totalCostUsd: number | null;
  totalCacheSavedUsd: number | null;
}

export interface TelemetryReport {
  conversationId?: string;
  updatedAt?: string;
  model: string;
  pricingSource: string;
  context: TelemetryContext;
  latest: TelemetryLatest | null;
  session: TelemetrySession;
  subagents: SubagentSummary;
  turns: TurnSummary[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  status: string;
  lastModifiedTime: string;
  stepCount: number;
  isChild: boolean;
}

export type CdpState =
  | 'checking'
  | 'attached'
  | 'standby'
  | 'port_not_enabled'
  | 'no_target'
  | 'error';

export interface CdpStatus {
  state: CdpState;
  port: number | null;
  targets: number;
  detail: string;
}

export type TelemetryApiResponse =
  | {
      unchanged: true;
      etag: string;
      conversationId: string | null;
      updatedAt?: string;
      cdp: CdpStatus;
    }
  | {
      unchanged: false;
      etag: string;
      conversationId: string | null;
      conversations: ConversationSummary[];
      telemetry: TelemetryReport | null;
      loading: boolean;
      error: string | null;
      cdp: CdpStatus;
    };

export interface CapsulePayload {
  context: {
    used: number;
    limit: number;
    pct: number;
  };
  latest: {
    tps: number | null;
    ttftSec: number | null;
    cacheHitPct: number | null;
    costUsd: number | null;
  };
  session: {
    avgTps: number | null;
    medianTtftSec: number | null;
    cacheHitPct: number | null;
    totalCostUsd: number | null;
  };
}
