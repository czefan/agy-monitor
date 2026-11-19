import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { CapsuleManager } from './cdp.mjs';
import { PricingCatalog } from './pricing.mjs';
import { fetchConversations, fetchTelemetry, UUID_RE } from './telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript'],
};

const POLL_INTERVAL_MS = 2000;
const STALE_CACHE_MS = 1800;
const ACTIVE_CLIENT_WINDOW_MS = 10_000;
const MAX_CACHED_CONVS = 20;

const app = new SidecarApp();
const pricingCatalog = new PricingCatalog();

const cache = {
  conversations: [],
  childrenByRoot: new Map(),
  telemetryByConv: new Map(), // convId -> { data, fetchedAt, error, etag }
  breakdownByConv: new Map(), // convId -> { groups, heavyConsumers }
  trajByConv: new Map(),      // convId -> { stepCount, stats }
  subByConv: new Map(),       // subConvId -> { report, pricingSource }
  inFlight: new Map(),
  lastConvFetchAt: 0,
  lastUiPollAt: 0,
};

function computeTelemetryEtag(convId, data, cdpState) {
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

function setTelemetryCache(convId, value) {
  cache.telemetryByConv.delete(convId);
  cache.telemetryByConv.set(convId, value);
  while (cache.telemetryByConv.size > MAX_CACHED_CONVS) {
    const oldestKey = cache.telemetryByConv.keys().next().value;
    cache.telemetryByConv.delete(oldestKey);
  }
}

async function refreshConversations(force = false) {
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

async function refreshTelemetry(convId, force = false) {
  if (!convId || !UUID_RE.test(convId)) return null;
  const existing = cache.telemetryByConv.get(convId);
  if (!force && existing && Date.now() - existing.fetchedAt < STALE_CACHE_MS) {
    return existing.data;
  }
  if (cache.inFlight.has(convId)) return cache.inFlight.get(convId);

  const task = (async () => {
    try {
      const convMeta = cache.conversations.find((c) => c.id === convId);
      const data = await fetchTelemetry(convId, {
        stepCount: force ? null : (convMeta?.stepCount ?? null),
        extraChildren: cache.childrenByRoot.get(convId) || [],
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
          cache.breakdownByConv.delete(cache.breakdownByConv.keys().next().value);
        }
      } else if (data?.context) {
        const lastBreakdown = cache.breakdownByConv.get(convId);
        if (lastBreakdown) {
          data.context.groups = lastBreakdown.groups;
          data.context.heavyConsumers = lastBreakdown.heavyConsumers;
        }
      }
      setTelemetryCache(convId, { data, fetchedAt: Date.now(), error: null });
      return data;
    } catch (err) {
      setTelemetryCache(convId, {
        data: existing?.data || null,
        fetchedAt: Date.now(),
        error: err.message,
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

function pickActiveConversation(requestedConvId) {
  if (requestedConvId && UUID_RE.test(requestedConvId)) return requestedConvId;
  if (app.config?.conversationId && UUID_RE.test(app.config.conversationId)) return app.config.conversationId;
  if (process.env.ANTIGRAVITY_CONVERSATION_ID && UUID_RE.test(process.env.ANTIGRAVITY_CONVERSATION_ID)) {
    return process.env.ANTIGRAVITY_CONVERSATION_ID;
  }
  const topMain = cache.conversations.find((c) => !c.isChild);
  return topMain?.id || cache.conversations[0]?.id || '';
}

let ticking = false;

async function backgroundTick(isInitial = false) {
  if (ticking) return;
  ticking = true;
  try {
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

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
}

app.api('/api/telemetry', (data) => {
  cache.lastUiPollAt = Date.now();
  const convId = pickActiveConversation(data?.conversationId);
  const force = data?.refresh === '1' || data?.refresh === 'true';

  if (force || !cache.lastConvFetchAt) {
    void refreshConversations(force);
  }
  const entry = convId ? cache.telemetryByConv.get(convId) : null;
  if (convId && (force || !entry || Date.now() - entry.fetchedAt >= STALE_CACHE_MS)) {
    void refreshTelemetry(convId, force);
  }

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

process.on('SIGTERM', () => {
  clearInterval(timer);
  cdpManager.closeAll();
  process.exit(0);
});

app.run();
