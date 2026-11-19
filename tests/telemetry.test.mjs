import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelsDevPricingMap,
  computeTurnCostUsd,
  normalizeModelKey,
  resolveModelPrice,
} from '../sidecars/agy-monitor/pricing.mjs';
import {
  buildSubagentSummary,
  buildTelemetryReport,
  describeStep,
  extractHeavyConsumers,
  extractTrajectoryStats,
  getContextLevel,
  median,
  parseDurationSeconds,
} from '../sidecars/agy-monitor/telemetry.mjs';

test('parseDurationSeconds parses protobuf seconds strings and numbers', () => {
  assert.equal(parseDurationSeconds('12.981315700s'), 12.9813157);
  assert.equal(parseDurationSeconds('0s'), 0);
  assert.equal(parseDurationSeconds(1.5), 1.5);
  assert.equal(parseDurationSeconds('invalid'), null);
  assert.equal(parseDurationSeconds(null), null);
});

test('getContextLevel follows 80% warn and 95% danger thresholds', () => {
  assert.equal(getContextLevel(79.9), 'ok');
  assert.equal(getContextLevel(80), 'warn');
  assert.equal(getContextLevel(94.99), 'warn');
  assert.equal(getContextLevel(95), 'danger');
});

test('median handles odd and even lists', () => {
  assert.equal(median([]), null);
  assert.equal(median([10, 2, 5]), 5);
  assert.equal(median([10, 2, 4, 8]), 6);
});

test('buildTelemetryReport computes context, weighted TPS, median TTFT, and cache hit rate', () => {
  const report = buildTelemetryReport([
    {
      stepIndices: [1, 2],
      chatModel: {
        modelDisplayName: 'Gemini 4 Hydrogen (High)',
        responseModel: 'gemini-4-hydrogen',
        timeToFirstToken: '4.0s',
        streamingDuration: '2.0s',
        usage: {
          inputTokens: '1000',
          cacheReadTokens: '9000',
          outputTokens: '200',
          thinkingOutputTokens: '50',
          responseOutputTokens: '150',
        },
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 100000,
            maxContextTokens: 512000,
            tokenBreakdown: {
              groups: [
                { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 5000 },
                { name: 'Chat Messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 95000 },
              ],
            },
          },
        },
      },
    },
    {
      stepIndices: [3, 4],
      chatModel: {
        modelDisplayName: 'Gemini 4 Hydrogen (High)',
        responseModel: 'gemini-4-hydrogen',
        timeToFirstToken: '8.0s',
        streamingDuration: '4.0s',
        usage: {
          inputTokens: '2000',
          cacheReadTokens: '18000',
          outputTokens: '600',
          thinkingOutputTokens: '200',
          responseOutputTokens: '400',
        },
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 420000,
            maxContextTokens: 512000,
            tokenBreakdown: {
              groups: [
                { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 5000 },
                { name: 'Chat Messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 415000 },
              ],
            },
          },
        },
      },
    },
  ]);

  assert.equal(report.model, 'Gemini 4 Hydrogen (High)');
  assert.equal(report.context.used, 420000);
  assert.equal(report.context.limit, 512000);
  assert.ok(Math.abs(report.context.pct - (420000 / 512000) * 100) < 1e-9);
  assert.equal(report.context.level, 'warn');

  assert.equal(report.latest.tps, 150);
  assert.equal(report.latest.ttftSec, 8);
  assert.equal(report.latest.cacheHitPct, 90);

  // Weighted average TPS: (200 + 600) / (2.0 + 4.0) = 800 / 6
  assert.ok(Math.abs(report.session.avgTps - 800 / 6) < 1e-9);
  assert.equal(report.session.medianTtftSec, 6);
  assert.equal(report.session.cacheHitPct, 90);
  assert.equal(report.turns.length, 2);
  assert.equal(report.turns[0].index, 2);
});

test('buildTelemetryReport skips TPS on sub-50ms single-burst flushes', () => {
  const report = buildTelemetryReport([
    {
      stepIndices: [1],
      chatModel: {
        timeToFirstToken: '5.0s',
        streamingDuration: '0.002s',
        usage: { inputTokens: '100', cacheReadTokens: '900', outputTokens: '200' },
        chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 1000, maxContextTokens: 10000 } },
      },
    },
  ]);
  assert.equal(report.latest.tps, null);
  assert.equal(report.session.avgTps, null);
  assert.equal(report.session.totalOutputTokens, 200);
});

test('buildTelemetryReport falls back to latest turn with tokenBreakdown when newest turn omits it', () => {
  const report = buildTelemetryReport([
    {
      chatModel: {
        usage: { inputTokens: '100', outputTokens: '50' },
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 10000,
            maxContextTokens: 100000,
            tokenBreakdown: {
              groups: [{ name: 'Chat Messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 9000 }],
            },
          },
        },
      },
    },
    {
      chatModel: {
        usage: { inputTokens: '200', outputTokens: '80' },
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 12000,
            maxContextTokens: 100000,
          },
        },
      },
    },
  ]);

  assert.equal(report.context.used, 12000);
  assert.equal(report.context.groups.length, 1);
  assert.equal(report.context.groups[0].tokens, 9000);
});

test('buildTelemetryReport handles empty metadata gracefully', () => {
  const report = buildTelemetryReport([]);
  assert.equal(report.context.used, 0);
  assert.equal(report.context.level, 'ok');
  assert.equal(report.latest, null);
  assert.equal(report.session.avgTps, null);
  assert.equal(report.session.cacheHitPct, null);
});

test('extractTrajectoryStats counts checkpoints and deduplicates subagent references', () => {
  const stats = extractTrajectoryStats({
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT' },
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT' },
      {
        type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
        status: 'CORTEX_STEP_STATUS_DONE',
        invokeSubagent: {
          subagents: [{ typeName: 'research', role: 'Code Auditor' }],
          results: [{ conversationId: '00f4ef5d-6d14-4756-886f-3cca540dc302' }],
        },
      },
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT' },
    ],
  });

  assert.equal(stats.checkpointCount, 2);
  assert.equal(stats.stepLabels.length, 4);
  assert.equal(stats.stepLabels[1], '上下文压缩');
  assert.equal(stats.subagentRefs.length, 1);
  assert.equal(stats.subagentRefs[0].role, 'Code Auditor');
});

test('extractHeavyConsumers ranks top chat steps and resolves step descriptions', () => {
  const groups = [
    {
      type: 'TOKEN_TYPE_CHAT_MESSAGES',
      children: [
        { name: '0: USER_INPUT', numTokens: 200 },
        { name: '1: GENERIC', numTokens: 12000 },
        { name: '2: GENERIC', numTokens: 4500 },
      ],
    },
  ];
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT' },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { absolutePathUri: 'file:///d:/repo/large.json' } },
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { commandLine: 'pnpm test' } },
  ];

  const top = extractHeavyConsumers(groups, steps, 100000);
  assert.equal(top.length, 3);
  assert.equal(top[0].stepIndex, 1);
  assert.equal(top[0].label, '读取 large.json');
  assert.equal(top[0].pct, 12);
  assert.equal(top[1].label, '命令 pnpm test');
  assert.equal(describeStep({ codeAction: { actionSpec: { createFile: { path: { absoluteUri: 'file:///d:/a.js' } } } } }), '编辑 a.js');
  assert.equal(describeStep(undefined, 'GENERIC'), 'GENERIC');
});

test('buildSubagentSummary totals input, cache, and output tokens across subagents', () => {
  const summary = buildSubagentSummary([
    {
      ref: { conversationId: 'sub-1', role: 'Auditor', typeName: 'research' },
      report: {
        model: 'Gemini 4 Flash',
        session: {
          turnsCount: 4,
          totalInputTokens: 1000,
          totalCacheReadTokens: 8000,
          totalOutputTokens: 500,
          avgTps: 180,
        },
      },
    },
    {
      ref: { conversationId: 'sub-2', role: 'Tester', typeName: 'self' },
      report: {
        model: 'Gemini 4 Hydrogen (High)',
        session: {
          turnsCount: 2,
          totalInputTokens: 500,
          totalCacheReadTokens: 2000,
          totalOutputTokens: 300,
          avgTps: 220,
        },
      },
    },
  ]);

  assert.equal(summary.count, 2);
  assert.equal(summary.totalInputTokens, 1500);
  assert.equal(summary.totalCacheReadTokens, 10000);
  assert.equal(summary.totalOutputTokens, 800);
  assert.equal(summary.items[0].role, 'Auditor');
});

test('pricing helpers normalize model slugs, prefer first-party rates, and calculate USD cost', () => {
  assert.equal(normalizeModelKey('google/gemini-4-hydrogen'), 'gemini4hydrogen');
  assert.equal(normalizeModelKey('Gemini 4 Hydrogen (High)'), 'gemini4hydrogen');
  assert.equal(normalizeModelKey('claude-sonnet-5-5-high'), 'claudesonnet55');

  const map = buildModelsDevPricingMap({
    openrouter: {
      models: {
        'google/gemini-3.8-flash': { name: 'Gemini 3.8 Flash', cost: { input: 0.825, output: 4.125, cache_read: 0.0825 } },
      },
    },
    google: {
      models: {
        'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', cost: { input: 0.75, output: 3.75, cache_read: 0.075 } },
        'gemini-4-hydrogen': { name: 'Gemini 4 Hydrogen', cost: { input: 1.5, output: 7.5, cache_read: 0.075 } },
      },
    },
  });

  const flashRate = resolveModelPrice(map, 'gemini-3.8-flash', 'Gemini 3.8 Flash (High)');
  assert.ok(flashRate);
  assert.equal(flashRate.id, 'google/gemini-3.8-flash');
  assert.ok(Math.abs(flashRate.prompt - 0.75e-6) < 1e-12);
  assert.ok(Math.abs(flashRate.completion - 3.75e-6) < 1e-12);
  assert.ok(Math.abs(flashRate.cacheRead - 0.075e-6) < 1e-12);

  const hydroRate = resolveModelPrice(map, 'gemini-4-hydrogen', 'Gemini 4 Hydrogen (High)');
  const cost = computeTurnCostUsd({ inputTokens: 10000, cacheReadTokens: 100000, outputTokens: 2000 }, hydroRate);
  assert.ok(Math.abs(cost - (0.015 + 0.0075 + 0.015)) < 1e-12);
});
