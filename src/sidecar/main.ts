import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import type {
  ContextGroupItem,
  ConversationSummary,
  HeavyConsumerItem,
  TelemetryApiResponse,
  TelemetryReport,
} from '../shared/types.js';
import { CapsuleManager } from './cdp.js';
import { PricingCatalog } from './pricing.js';
import {
  fetchConversations,
  fetchTelemetry,
  UUID_RE,
  type CachedSubagentEntry,
  type CachedTrajectoryEntry,
  type SubagentRef,
} from './telemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..', 'web');

const POLL_INTERVAL_MS = 2000;
const STALE_CACHE_MS = 1800;
const IDLE_CACHE_MAX_MS = 60_000;
const ACTIVE_CLIENT_WINDOW_MS = 10_000;
const MAX_CACHED_CONVS = 20;

interface CachedTelemetryEntry {
  data: TelemetryReport | null;
  fetchedAt: number;
  error: string | null;
  fingerprint: string;
}

interface CachedBreakdownEntry {
  groups: ContextGroupItem[];
  heavyConsumers: HeavyConsumerItem[];
}

const app = new SidecarApp();
const pricingCatalog = new PricingCatalog();

const cache = {
  conversations: [] as ConversationSummary[],
  childrenByRoot: new Map<string, SubagentRef[]>(),
  telemetryByConv: new Map<string, CachedTelemetryEntry>(),
  breakdownByConv: new Map<string, CachedBreakdownEntry>(),
  trajByConv: new Map<string, CachedTrajectoryEntry>(),
  subByConv: new Map<string, CachedSubagentEntry>(),
  inFlight: new Map<string, Promise<TelemetryReport | null>>(),
  lastConvFetchAt: 0,
  lastUiPollAt: 0,
};

function computeTelemetryEtag(
  convId: string,
  data: TelemetryReport | null | undefined,
  cdpState: string,
): string {
  if (!data) return `${convId}|none|${cdpState}`;
  return [
    convId,
    data.session?.turnsCount || 0,
    data.latest?.outputTokens || 0,
    data.context?.used || 0,
    data.context?.groups?.length || 0,
    data.context?.heavyConsumers?.length || 0,
    data.context?.checkpointCount || 0,
    data.subagents?.count || 0,
    data.subagents?.totalOutputTokens || 0,
    data.pricingSource || '',
    cdpState || '',
  ].join('|');
}

function setTelemetryCache(convId: string, value: CachedTelemetryEntry): void {
  cache.telemetryByConv.delete(convId);
  cache.telemetryByConv.set(convId, value);
  while (cache.telemetryByConv.size > MAX_CACHED_CONVS) {
    const oldestKey = cache.telemetryByConv.keys().next().value;
    if (oldestKey !== undefined) cache.telemetryByConv.delete(oldestKey);
  }
}

async function refreshConversations(force = false): Promise<ConversationSummary[]> {
  const now = Date.now();
  if (!force && now - cache.lastConvFetchAt < STALE_CACHE_MS && cache.conversations.length) {
    return cache.conversations;
  }
  try {
    const res = await fetchConversations();
    cache.conversations = res.conversations;
    cache.childrenByRoot = res.childrenByRoot;
    cache.lastConvFetchAt = Date.now();
  } catch {
    // Keep last known conversation list on transient LS error.
  }
  return cache.conversations;
}

async function refreshTelemetry(convId: string, force = false): Promise<TelemetryReport | null> {
  if (!convId || !UUID_RE.test(convId)) return null;
  const now = Date.now();
  const existing = cache.telemetryByConv.get(convId);
  if (!force && existing && now - existing.fetchedAt < STALE_CACHE_MS) {
    return existing.data;
  }

  const convMeta = cache.conversations.find((c) => c.id === convId);
  const children = cache.childrenByRoot.get(convId) || [];
  const fingerprint = convMeta
    ? [
        convMeta.status,
        convMeta.stepCount,
        convMeta.lastModifiedTime,
        pricingCatalog.source,
        pricingCatalog.fetchedAt,
        children.length,
      ].join('|')
    : '';
  const isIdleUnchanged =
    !force &&
    existing?.data &&
    !existing.error &&
    convMeta?.status === 'CASCADE_RUN_STATUS_IDLE' &&
    fingerprint &&
    existing.fingerprint === fingerprint &&
    (existing.data.session?.turnsCount === 0 || existing.data.context?.groups?.length > 0) &&
    now - existing.fetchedAt < IDLE_CACHE_MAX_MS;
  if (isIdleUnchanged) {
    return existing.data;
  }

  const inflight = cache.inFlight.get(convId);
  if (inflight) return inflight;

  const task = (async (): Promise<TelemetryReport | null> => {
    try {
      const data = await fetchTelemetry(convId, {
        stepCount: force ? null : (convMeta?.stepCount ?? null),
        extraChildren: children,
        trajCache: cache.trajByConv,
        subCache: cache.subByConv,
        pricingMap: pricingCatalog.map,
        pricingSource: pricingCatalog.source,
      });
      if (data?.context?.groups?.length > 0) {
        cache.breakdownByConv.set(convId, {
          groups: data.context.groups,
          heavyConsumers: data.context.heavyConsumers || [],
        });
        while (cache.breakdownByConv.size > MAX_CACHED_CONVS) {
          const oldestKey = cache.breakdownByConv.keys().next().value;
          if (oldestKey !== undefined) cache.breakdownByConv.delete(oldestKey);
        }
      } else if (data?.context) {
        const lastBreakdown = cache.breakdownByConv.get(convId);
        if (lastBreakdown) {
          data.context.groups = lastBreakdown.groups;
          data.context.heavyConsumers = lastBreakdown.heavyConsumers;
        }
      }
      setTelemetryCache(convId, { data, fetchedAt: Date.now(), error: null, fingerprint });
      return data;
    } catch (err) {
      setTelemetryCache(convId, {
        data: existing?.data || null,
        fetchedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        fingerprint: existing?.fingerprint || '',
      });
      return existing?.data || null;
    } finally {
      cache.inFlight.delete(convId);
    }
  })();

  cache.inFlight.set(convId, task);
  return task;
}

const cdpManager = new CapsuleManager((convId) => refreshTelemetry(convId));

function pickActiveConversation(requestedConvId?: string): string {
  if (requestedConvId && UUID_RE.test(requestedConvId)) return requestedConvId;
  if (app.config?.conversationId && UUID_RE.test(app.config.conversationId)) {
    return app.config.conversationId;
  }
  const envConv = process.env.ANTIGRAVITY_CONVERSATION_ID;
  if (envConv && UUID_RE.test(envConv)) return envConv;
  const topMain = cache.conversations.find((c) => !c.isChild);
  return topMain?.id || cache.conversations[0]?.id || '';
}

let ticking = false;
let lsMissCount = 0;

function parseAssignedLsEndpoint(): { host: string; port: number } | null {
  const raw = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  if (!raw) return null;
  try {
    const normalized = raw.includes('://') ? raw : `http://${raw}`;
    const u = new URL(normalized);
    const port = Number(u.port);
    return u.hostname && port > 0 ? { host: u.hostname, port } : null;
  } catch {
    return null;
  }
}

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const assignedLs = parseAssignedLsEndpoint();

async function backgroundTick(isInitial = false): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (assignedLs) {
      const alive = await probeTcp(assignedLs.host, assignedLs.port);
      lsMissCount = alive ? 0 : lsMissCount + 1;
      if (lsMissCount >= 3) {
        shutdown();
        return;
      }
    }
    await pricingCatalog.refreshIfNeeded();
    const uiActive = Date.now() - cache.lastUiPollAt < ACTIVE_CLIENT_WINDOW_MS;
    const cdpAttached = cdpManager.status.state === 'attached';
    if (isInitial || uiActive || cdpAttached) {
      await refreshConversations();
      const activeConv = pickActiveConversation();
      if (activeConv) await refreshTelemetry(activeConv);
      await cdpManager.tick(activeConv);
    } else {
      await cdpManager.tick(pickActiveConversation());
    }
  } finally {
    ticking = false;
  }
}

app.page('/', () => readFileSync(join(WEB_ROOT, 'index.html'), 'utf-8'));

app.api(
  '/styles.css',
  () => new Response(readFileSync(join(WEB_ROOT, 'styles.css'), 'utf-8'), { contentType: 'text/css' }),
  'GET',
);

app.api(
  '/app.js',
  () =>
    new Response(readFileSync(join(WEB_ROOT, 'app.js'), 'utf-8'), {
      contentType: 'application/javascript',
    }),
  'GET',
);

app.api('/api/telemetry', async (data): Promise<TelemetryApiResponse> => {
  cache.lastUiPollAt = Date.now();
  let convId = pickActiveConversation(data?.conversationId);
  const force = data?.refresh === '1' || data?.refresh === 'true';

  if (force) {
    await refreshConversations(true);
    convId = pickActiveConversation(data?.conversationId);
    if (convId) await refreshTelemetry(convId, true);
  } else {
    if (!cache.lastConvFetchAt) void refreshConversations(false);
    const cached = convId ? cache.telemetryByConv.get(convId) : null;
    if (convId && (!cached || Date.now() - cached.fetchedAt >= STALE_CACHE_MS)) {
      void refreshTelemetry(convId, false);
    }
  }

  const entry = convId ? cache.telemetryByConv.get(convId) : null;

  const etag = computeTelemetryEtag(convId, entry?.data, cdpManager.status.state);
  if (!force && data?.etag && data.etag === etag && entry?.data) {
    return {
      unchanged: true,
      etag,
      conversationId: convId || null,
      updatedAt: entry.data.updatedAt,
      cdp: cdpManager.status,
    };
  }

  return {
    unchanged: false,
    etag,
    conversationId: convId || null,
    conversations: cache.conversations.filter((c) => !c.isChild || c.id === convId).slice(0, 20),
    telemetry: entry?.data || null,
    loading: Boolean(convId && !entry?.data && !entry?.error),
    error: entry?.error || null,
    cdp: cdpManager.status,
  };
}, 'GET');

void backgroundTick(true);
const timer = setInterval(() => void backgroundTick(), POLL_INTERVAL_MS);
timer.unref?.();

function shutdown(): void {
  clearInterval(timer);
  cdpManager.closeAll(true);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

void app.run();
