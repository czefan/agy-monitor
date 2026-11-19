import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { computeTurnCostUsd, resolveModelPrice } from './pricing.mjs';

export const WARN_THRESHOLD_PCT = 80;
export const DANGER_THRESHOLD_PCT = 95;
export const MIN_STREAM_DURATION_SEC = 0.05;
export const RECENT_TURNS_LIMIT = 20;
export const UUID_RE = /^[0-9a-f-]{8,}$/i;

let cachedEndpoints = null;
let endpointsCachedAt = 0;
const ENDPOINTS_TTL_MS = 15_000;

/**
 * Parse a Protobuf duration string like "12.981315700s" into seconds.
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parseDurationSeconds(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.endsWith('s')) return null;
  const val = Number.parseFloat(trimmed.slice(0, -1));
  return Number.isFinite(val) && val >= 0 ? val : null;
}

/**
 * Convert numeric or string integer token counts safely.
 * @param {string|number|null|undefined} raw
 * @returns {number}
 */
export function toInt(raw) {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compute median of finite numeric samples.
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  const valid = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

/**
 * Determine context usage severity tier from percentage.
 * @param {number} pct
 * @returns {'ok'|'warn'|'danger'}
 */
export function getContextLevel(pct) {
  if (pct >= DANGER_THRESHOLD_PCT) return 'danger';
  if (pct >= WARN_THRESHOLD_PCT) return 'warn';
  return 'ok';
}

/**
 * Parse a single generatorMetadata entry into a normalized turn record.
 * @param {object} entry
 * @param {number} index
 * @returns {object|null}
 */
function parseTurn(entry, index) {
  const cm = entry?.chatModel;
  if (!cm || typeof cm !== 'object') return null;

  const usage = cm.usage || {};
  const inputTokens = toInt(usage.inputTokens);
  const cacheReadTokens = toInt(usage.cacheReadTokens);
  const outputTokens = toInt(usage.outputTokens);
  const thinkingTokens = toInt(usage.thinkingOutputTokens);
  const responseTokens = toInt(usage.responseOutputTokens);
  const promptTotal = inputTokens + cacheReadTokens;
  const cacheHitPct = promptTotal > 0 ? (cacheReadTokens / promptTotal) * 100 : null;

  const ttftSec = parseDurationSeconds(cm.timeToFirstToken);
  const streamSec = parseDurationSeconds(cm.streamingDuration);
  const tps = streamSec && streamSec >= MIN_STREAM_DURATION_SEC && outputTokens > 0 ? outputTokens / streamSec : null;

  const cwm = cm.chatStartMetadata?.contextWindowMetadata || {};
  const contextUsed = toInt(cwm.estimatedTokensUsed);
  const contextLimit = toInt(cwm.maxContextTokens);
  const contextPct = contextLimit > 0 ? (contextUsed / contextLimit) * 100 : 0;

  const groups = Array.isArray(cwm.tokenBreakdown?.groups)
    ? cwm.tokenBreakdown.groups.map((g) => ({
        name: g.name || g.type || 'Other',
        type: g.type || '',
        tokens: toInt(g.numTokens),
        children: Array.isArray(g.children) ? g.children : [],
      }))
    : [];

  return {
    index,
    model: cm.modelDisplayName || cm.responseModel || usage.model || 'Unknown',
    responseModel: cm.responseModel || usage.model || '',
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    cacheHitPct,
    ttftSec,
    streamSec,
    tps,
    contextUsed,
    contextLimit,
    contextPct,
    groups,
  };
}

/**
 * Safely extract the basename from a string path/URI or Protobuf file path object.
 * @param {string|object|null|undefined} raw
 * @returns {string}
 */
function safeBasename(raw) {
  const str = typeof raw === 'string'
    ? raw
    : (raw?.absoluteUri || raw?.fsPath || raw?.path || raw?.uri || '');
  if (typeof str !== 'string' || !str) return '';
  try {
    return basename(decodeURIComponent(str));
  } catch {
    return basename(str);
  }
}

/**
 * Build a concise human-readable label for a trajectory step.
 * @param {object|undefined} step
 * @param {string} fallbackType
 * @returns {string}
 */
export function describeStep(step, fallbackType = '') {
  if (typeof step === 'string') return step || fallbackType || '未知步骤';
  if (!step || typeof step !== 'object') {
    return fallbackType || '未知步骤';
  }
  if (step.viewFile?.absolutePathUri) {
    return `读取 ${safeBasename(step.viewFile.absolutePathUri)}`;
  }
  if (step.runCommand?.commandLine) {
    const cmd = String(step.runCommand.commandLine).replace(/\s+/g, ' ').trim();
    return `命令 ${cmd.length > 36 ? `${cmd.slice(0, 36)}…` : cmd}`;
  }
  if (step.mcpTool?.toolName) {
    return `MCP ${step.mcpTool.serverName || ''}/${step.mcpTool.toolName}`.replace(/^\//, '');
  }
  if (step.codeAction?.actionSpec) {
    const spec = step.codeAction.actionSpec;
    const name = safeBasename(spec.createFile?.path || spec.editFile?.path || spec.writeFile?.path);
    return name ? `编辑 ${name}` : '代码编辑';
  }
  if (step.invokeSubagent?.subagents?.length) {
    const roles = step.invokeSubagent.subagents.map((s) => s.role || s.typeName).filter(Boolean).join(', ');
    return `子代理 ${roles || '调用'}`;
  }

  const type = String(step.type || fallbackType || '');
  const map = {
    CORTEX_STEP_TYPE_USER_INPUT: '用户输入',
    CORTEX_STEP_TYPE_PLANNER_RESPONSE: '模型回复/工具调用',
    CORTEX_STEP_TYPE_SEARCH_WEB: '网页搜索',
    CORTEX_STEP_TYPE_ASK_QUESTION: '交互提问',
    CORTEX_STEP_TYPE_SYSTEM_MESSAGE: '系统消息',
    CORTEX_STEP_TYPE_CHECKPOINT: '上下文压缩',
    USER_INPUT: '用户输入',
    PLANNER_RESPONSE: '模型回复/工具调用',
    GENERIC: '工具/上下文输出',
  };
  return map[type] || type.replace(/^CORTEX_STEP_TYPE_/, '') || '步骤';
}

/**
 * Extract top heavyweight context consumers from the chat-messages breakdown children.
 * @param {Array<object>} groups
 * @param {Array<object>} steps
 * @param {number} contextLimit
 * @param {number} topN
 * @returns {Array<{stepIndex: number|null, label: string, tokens: number, pct: number}>}
 */
export function extractHeavyConsumers(groups, steps = [], contextLimit = 0, topN = 8) {
  const chatGroup = (Array.isArray(groups) ? groups : []).find((g) => g.type === 'TOKEN_TYPE_CHAT_MESSAGES');
  const children = Array.isArray(chatGroup?.children) ? chatGroup.children : [];

  return children
    .map((child) => {
      const name = String(child?.name || '');
      const match = name.match(/^(\d+):\s*(.*)$/);
      const stepIndex = match ? Number.parseInt(match[1], 10) : null;
      const fallbackType = match ? match[2] : name;
      const tokens = toInt(child?.numTokens);
      const step = stepIndex !== null ? steps[stepIndex] : undefined;
      return {
        stepIndex,
        label: describeStep(step, fallbackType),
        tokens,
        pct: contextLimit > 0 ? (tokens / contextLimit) * 100 : 0,
      };
    })
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, topN);
}

/**
 * Extract compaction checkpoint count, lightweight step labels, and subagent references.
 * Storing labels instead of raw steps keeps trajectory cache tiny in memory.
 * @param {object|null|undefined} trajectory
 * @returns {{checkpointCount: number, stepLabels: string[], subagentRefs: Array<{conversationId: string, role: string, typeName: string, status: string}>}}
 */
export function extractTrajectoryStats(trajectory) {
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
  let checkpointCount = 0;
  const stepLabels = new Array(steps.length);
  const subagentMap = new Map();

  for (let idx = 0; idx < steps.length; idx += 1) {
    const step = steps[idx];
    stepLabels[idx] = describeStep(step);
    if (step?.type === 'CORTEX_STEP_TYPE_CHECKPOINT') {
      checkpointCount += 1;
    }
    if (step?.type === 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT' && step.invokeSubagent) {
      const specs = Array.isArray(step.invokeSubagent.subagents) ? step.invokeSubagent.subagents : [];
      const results = Array.isArray(step.invokeSubagent.results) ? step.invokeSubagent.results : [];
      for (let i = 0; i < results.length; i += 1) {
        const subId = results[i]?.conversationId;
        if (!subId || !UUID_RE.test(subId)) continue;
        const spec = specs[i] || specs[0] || {};
        subagentMap.set(subId, {
          conversationId: subId,
          role: spec.role || spec.typeName || 'Subagent',
          typeName: spec.typeName || '',
          status: step.status || '',
        });
      }
    }
  }

  return {
    checkpointCount,
    stepLabels,
    subagentRefs: [...subagentMap.values()],
  };
}

/**
 * Transform GetCascadeTrajectoryGeneratorMetadata entries into telemetry summary and turn list.
 * @param {Array<object>} generatorMetadata
 * @param {{checkpointCount?: number, steps?: Array<object>, subagents?: object, pricingMap?: Map, pricingSource?: string}|null} extra
 * @returns {object}
 */
export function buildTelemetryReport(generatorMetadata, extra = null) {
  const entries = Array.isArray(generatorMetadata) ? generatorMetadata : [];
  const pricingMap = extra?.pricingMap || null;
  const turns = [];

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let totalCostUsd = 0;
  let totalCacheSavedUsd = 0;
  let pricedTurns = 0;
  let tpsOutputSum = 0;
  let tpsStreamSecSum = 0;
  const ttftSamples = [];

  for (const entry of entries) {
    const turn = parseTurn(entry, turns.length + 1);
    if (!turn) continue;

    const rate = resolveModelPrice(pricingMap, turn.responseModel, turn.model);
    const costUsd = computeTurnCostUsd(turn, rate);
    if (costUsd !== null) {
      totalCostUsd += costUsd;
      totalCacheSavedUsd += turn.cacheReadTokens * Math.max(0, rate.prompt - rate.cacheRead);
      pricedTurns += 1;
    }
    turn.costUsd = costUsd;
    turns.push(turn);

    totalInputTokens += turn.inputTokens;
    totalCacheReadTokens += turn.cacheReadTokens;
    totalOutputTokens += turn.outputTokens;
    totalThinkingTokens += turn.thinkingTokens;
    totalResponseTokens += turn.responseTokens;

    if (turn.tps !== null) {
      tpsOutputSum += turn.outputTokens;
      tpsStreamSecSum += turn.streamSec;
    }
    if (turn.ttftSec !== null) {
      ttftSamples.push(turn.ttftSec);
    }
  }

  const latest = turns.length ? turns[turns.length - 1] : null;
  const latestWithGroups = [...turns].reverse().find((t) => t.groups.length > 0) || latest;
  const totalPromptTokens = totalInputTokens + totalCacheReadTokens;
  const sessionCacheHitPct = totalPromptTokens > 0 ? (totalCacheReadTokens / totalPromptTokens) * 100 : null;
  const latestGroups = latestWithGroups?.groups || [];
  const heavyConsumers = extractHeavyConsumers(latestGroups, extra?.stepLabels || extra?.steps || [], latest?.contextLimit || 0);

  return {
    model: latest?.model || 'No active turn',
    pricingSource: extra?.pricingSource || (pricedTurns > 0 ? 'openrouter' : 'unavailable'),
    context: latest
      ? {
          used: latest.contextUsed,
          limit: latest.contextLimit,
          pct: latest.contextPct,
          level: getContextLevel(latest.contextPct),
          checkpointCount: extra?.checkpointCount ?? 0,
          groups: latestGroups.map(({ name, type, tokens }) => ({ name, type, tokens })),
          heavyConsumers,
        }
      : { used: 0, limit: 0, pct: 0, level: 'ok', checkpointCount: extra?.checkpointCount ?? 0, groups: [], heavyConsumers: [] },
    latest: latest
      ? {
          tps: latest.tps,
          ttftSec: latest.ttftSec,
          inputTokens: latest.inputTokens,
          cacheReadTokens: latest.cacheReadTokens,
          outputTokens: latest.outputTokens,
          thinkingTokens: latest.thinkingTokens,
          responseTokens: latest.responseTokens,
          cacheHitPct: latest.cacheHitPct,
          costUsd: latest.costUsd,
        }
      : null,
    session: {
      turnsCount: turns.length,
      avgTps: tpsStreamSecSum > 0 ? tpsOutputSum / tpsStreamSecSum : null,
      medianTtftSec: median(ttftSamples),
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      totalThinkingTokens,
      totalResponseTokens,
      cacheHitPct: sessionCacheHitPct,
      totalCostUsd: pricedTurns > 0 ? totalCostUsd : null,
      totalCacheSavedUsd: pricedTurns > 0 ? totalCacheSavedUsd : null,
    },
    subagents: extra?.subagents || {
      count: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      items: [],
    },
    turns: turns.slice(-RECENT_TURNS_LIMIT).reverse().map(({ groups: _groups, responseModel: _rm, ...rest }) => rest),
  };
}

/**
 * Aggregate per-subagent telemetry summaries into a unified subagent report.
 * @param {Array<{ref: object, report: object}>} entries
 * @returns {object}
 */
export function buildSubagentSummary(entries) {
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  const items = [];

  for (const { ref, report } of entries) {
    const sess = report?.session || {};
    totalInputTokens += sess.totalInputTokens || 0;
    totalCacheReadTokens += sess.totalCacheReadTokens || 0;
    totalOutputTokens += sess.totalOutputTokens || 0;
    items.push({
      conversationId: ref.conversationId,
      role: ref.role,
      typeName: ref.typeName,
      model: report?.model || 'Unknown',
      turnsCount: sess.turnsCount || 0,
      inputTokens: sess.totalInputTokens || 0,
      cacheReadTokens: sess.totalCacheReadTokens || 0,
      outputTokens: sess.totalOutputTokens || 0,
      avgTps: sess.avgTps ?? null,
    });
  }

  return {
    count: items.length,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    items,
  };
}

/**
 * Resolve the Antigravity appData directory (e.g. ~/.gemini/antigravity).
 * @returns {string}
 */
export function resolveAppDataDir() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR && existsSync(process.env.ANTIGRAVITY_APP_DATA_DIR)) {
    return process.env.ANTIGRAVITY_APP_DATA_DIR;
  }
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const candidate = dirname(d);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  return join(geminiDir, 'antigravity');
}

/**
 * Discover Language Server endpoints (cached 15s; env first, then recent daemon/hub_*.json files).
 * @param {boolean} bypassCache
 * @returns {Array<{address: string, csrfToken: string}>}
 */
export function discoverLanguageServers(bypassCache = false) {
  const now = Date.now();
  if (!bypassCache && cachedEndpoints && now - endpointsCachedAt < ENDPOINTS_TTL_MS) {
    return cachedEndpoints;
  }

  const candidates = [];
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    candidates.push({
      address: process.env.ANTIGRAVITY_LS_ADDRESS,
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
    });
  }

  const daemonDir = join(resolveAppDataDir(), 'daemon');
  if (existsSync(daemonDir)) {
    try {
      const files = readdirSync(daemonDir)
        .filter((name) => /^hub_\d+\.json$/i.test(name))
        .map((name) => {
          const full = join(daemonDir, name);
          return { full, mtime: statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      for (const file of files.slice(0, 5)) {
        try {
          const data = JSON.parse(readFileSync(file.full, 'utf-8'));
          if (data?.httpPort && data?.csrfToken) {
            const addr = `127.0.0.1:${data.httpPort}`;
            if (!candidates.some((c) => c.address === addr)) {
              candidates.push({ address: addr, csrfToken: data.csrfToken });
            }
          }
        } catch {
          // Ignore malformed hub file.
        }
      }
    } catch {
      // Ignore unreadable daemon dir.
    }
  }

  cachedEndpoints = candidates;
  endpointsCachedAt = now;
  return candidates;
}

/**
 * Call LanguageServerService RPC over HTTP with automatic fallback across discovered endpoints.
 * @param {string} method
 * @param {object} body
 * @returns {Promise<object>}
 */
export async function callLsRpc(method, body = {}) {
  let endpoints = discoverLanguageServers(false);
  let lastErr = new Error('No Antigravity Language Server endpoint found');

  for (let pass = 0; pass < 2; pass += 1) {
    for (const ep of endpoints) {
      try {
        const res = await fetch(`http://${ep.address}/exa.language_server_pb.LanguageServerService/${method}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': ep.csrfToken,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) {
          lastErr = new Error(`LS RPC ${method} HTTP ${res.status}`);
          continue;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    if (pass === 0) endpoints = discoverLanguageServers(true);
  }

  throw lastErr;
}

/**
 * List recent conversations sorted by lastModifiedTime descending, plus child-parent map.
 * @returns {Promise<{conversations: Array<object>, childrenByRoot: Map<string, Array<object>>}>}
 */
export async function fetchConversations() {
  const res = await callLsRpc('GetAllCascadeTrajectories', {});
  const summaries = res?.trajectorySummaries || {};
  const conversations = [];
  const childrenByRoot = new Map();

  for (const [id, s] of Object.entries(summaries)) {
    const rootId = s.trajectoryMetadata?.rootConversationId;
    if (rootId && rootId !== id) {
      const list = childrenByRoot.get(rootId) || [];
      list.push({
        conversationId: id,
        role: s.summary || id.slice(0, 8),
        typeName: 'child',
        status: s.status || '',
      });
      childrenByRoot.set(rootId, list);
    }
    conversations.push({
      id,
      title: s.summary || id.slice(0, 8),
      status: s.status || '',
      lastModifiedTime: s.lastModifiedTime || '',
      stepCount: toInt(s.stepCount),
      isChild: Boolean(rootId && rootId !== id),
    });
  }

  conversations.sort((a, b) => String(b.lastModifiedTime).localeCompare(String(a.lastModifiedTime)));
  return { conversations, childrenByRoot };
}

/**
 * Fetch trajectory stats (checkpoints, steps, subagents) with optional stepCount cache.
 * @param {string} conversationId
 * @param {number|null} stepCount
 * @param {Map<string, {stepCount: number|null, stats: object}>} trajCache
 * @returns {Promise<object>}
 */
async function getTrajectoryStatsCached(conversationId, stepCount, trajCache) {
  const cached = trajCache?.get(conversationId);
  if (cached && stepCount !== null && cached.stepCount === stepCount) {
    return cached.stats;
  }
  try {
    const trajRes = await callLsRpc('GetCascadeTrajectory', { cascadeId: conversationId });
    const stats = extractTrajectoryStats(trajRes?.trajectory);
    if (trajCache) {
      trajCache.set(conversationId, { stepCount, stats });
      while (trajCache.size > 10) {
        trajCache.delete(trajCache.keys().next().value);
      }
    }
    return stats;
  } catch {
    return cached?.stats || { checkpointCount: 0, stepLabels: [], subagentRefs: [] };
  }
}

/**
 * Fetch and build full telemetry report (including checkpoints, top consumers, subagents, and pricing).
 * Caches completed subagent reports to avoid redundant RPCs on every poll.
 * @param {string} conversationId
 * @param {{stepCount?: number|null, extraChildren?: Array<object>, trajCache?: Map, subCache?: Map, pricingMap?: Map, pricingSource?: string}} options
 * @returns {Promise<object>}
 */
export async function fetchTelemetry(conversationId, options = {}) {
  const [gmRes, stats] = await Promise.all([
    callLsRpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: conversationId }),
    getTrajectoryStatsCached(conversationId, options.stepCount ?? null, options.trajCache),
  ]);

  const refMap = new Map();
  for (const r of stats.subagentRefs) refMap.set(r.conversationId, r);
  for (const r of options.extraChildren || []) {
    if (!refMap.has(r.conversationId)) refMap.set(r.conversationId, r);
  }

  const subRefs = [...refMap.values()];
  const subCache = options.subCache;
  const subEntries = await Promise.all(
    subRefs.map(async (ref) => {
      const isDone = ref.status === 'CORTEX_STEP_STATUS_DONE' || ref.status === 'CASCADE_RUN_STATUS_IDLE';
      const cached = subCache?.get(ref.conversationId);
      if (cached && isDone && cached.pricingSource === options.pricingSource) {
        return { ref, report: cached.report };
      }
      try {
        const subGm = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: ref.conversationId });
        const report = buildTelemetryReport(subGm?.generatorMetadata || [], { pricingMap: options.pricingMap });
        if (subCache && isDone) {
          subCache.set(ref.conversationId, { report, pricingSource: options.pricingSource });
          while (subCache.size > 40) subCache.delete(subCache.keys().next().value);
        }
        return { ref, report };
      } catch {
        return { ref, report: cached?.report || buildTelemetryReport([]) };
      }
    }),
  );

  return {
    conversationId,
    updatedAt: new Date().toISOString(),
    ...buildTelemetryReport(gmRes?.generatorMetadata || [], {
      checkpointCount: stats.checkpointCount,
      stepLabels: stats.stepLabels,
      subagents: buildSubagentSummary(subEntries),
      pricingMap: options.pricingMap,
      pricingSource: options.pricingSource,
    }),
  };
}
