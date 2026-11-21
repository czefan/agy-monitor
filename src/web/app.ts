import type {
  CdpStatus,
  ConversationSummary,
  HeavyConsumerItem,
  SubagentSummary,
  TelemetryApiResponse,
  TelemetryContext,
  TurnSummary,
} from '../shared/types.js';

interface TableCellSpec {
  text: string;
  cls?: string;
  title?: string;
}

const POLL_MS = 2000;
const FAST_POLL_MS = 350;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element: #${id}`);
  return el as T;
}

const GROUP_COLORS: Record<string, string> = {
  TOKEN_TYPE_CHAT_MESSAGES: '#3b82f6',
  TOKEN_TYPE_TOOLS: '#8b5cf6',
  TOKEN_TYPE_SYSTEM_PROMPT: '#64748b',
  TOKEN_TYPE_SKILLS: '#06b6d4',
  TOKEN_TYPE_SUBAGENTS: '#f59e0b',
  TOKEN_TYPE_PLUGINS: '#10b981',
  TOKEN_TYPE_RULES: '#ec4899',
  TOKEN_TYPE_MCP_TOOLS: '#6366f1',
};

const GROUP_LABELS: Record<string, string> = {
  'System Prompt': '系统提示词',
  'Chat Messages': '对话历史',
  Tools: '内置工具',
  Skills: 'Skills 技能',
  Subagents: '子代理',
  Plugins: '插件',
  Rules: '规则',
  'Mcp Tools': 'MCP 工具',
};

let manualConvId = '';
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let heavyExpanded = false;
let subExpanded = false;
let lastHeavyConsumers: HeavyConsumerItem[] = [];
let lastEtag = '';

function syncTheme(): void {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f1012)';
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (nums.length < 3) return;
  const scale = c.startsWith('color(') ? 1 : 255;
  const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
}

function fmtTokens(n: number | null | undefined): string {
  const num = Number(n || 0);
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(Math.round(num));
}

function fmtPct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : '--';
}

function fmtTps(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} t/s` : '--';
}

function fmtSec(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)} s` : '--';
}

function fmtUsd(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '--';
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function renderTableRows(
  tbody: HTMLTableSectionElement,
  colCount: number,
  emptyText: string,
  rows: TableCellSpec[][],
): void {
  tbody.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount;
    td.className = 'empty-cell';
    td.textContent = emptyText;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const cells of rows) {
    const tr = document.createElement('tr');
    for (const cell of cells) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.cls) td.className = cell.cls;
      if (cell.title) td.title = cell.title;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const res = await f(path, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function renderConversations(conversations: ConversationSummary[], activeId: string | null): void {
  const sel = byId<HTMLSelectElement>('conv-select');
  const list = Array.isArray(conversations) ? conversations : [];
  const key = list.map((c) => `${c.id}:${c.title}`).join('|');
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.replaceChildren();
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.title} (${c.stepCount})`;
      sel.appendChild(opt);
    }
  }
  if (activeId && sel.value !== activeId) sel.value = activeId;
}

function renderCdp(cdp: CdpStatus | null | undefined): void {
  const pill = byId<HTMLButtonElement>('cdp-pill');
  const hint = byId('cdp-hint');
  if (!cdp) return;
  pill.dataset.state = cdp.state || 'unknown';
  pill.textContent = '胶囊';
  if (cdp.state === 'attached') {
    pill.title = `输入框胶囊已挂载到 ${cdp.targets} 个窗口（点击查看详情）`;
    hint.textContent = `已连接桌面端调试端口（127.0.0.1:${cdp.port}），输入框胶囊已挂载到 ${cdp.targets} 个窗口。`;
  } else if (cdp.state === 'standby') {
    pill.title = '由其他活跃窗口挂载胶囊（点击查看详情）';
    hint.textContent =
      '检测到另一个活跃窗口的 AGY Monitor 实例正在挂载胶囊，当前实例保持待命以避免冲突。';
  } else if (cdp.state === 'port_not_enabled') {
    pill.title = '未检测到调试端口，点击查看开启方法';
    hint.textContent =
      '未检测到桌面端调试端口（DevToolsActivePort），因此输入框胶囊暂未挂载。若需开启，请为 Antigravity 桌面快捷方式添加启动参数 --remote-debugging-port=0 并重启应用。';
  } else {
    pill.title = '输入框胶囊暂未挂载（点击查看状态）';
    hint.textContent = `当前未挂载输入框胶囊（状态: ${cdp.detail || cdp.state || 'unknown'}）。`;
  }
}

function renderHeavyConsumers(items: HeavyConsumerItem[]): void {
  lastHeavyConsumers = Array.isArray(items) ? items : [];
  const limit = heavyExpanded ? 8 : 3;
  const toggleBtn = byId<HTMLButtonElement>('heavy-toggle');
  toggleBtn.textContent = heavyExpanded
    ? '收起'
    : `展开 Top ${Math.min(lastHeavyConsumers.length, 8) || 8}`;
  toggleBtn.classList.toggle('hidden', lastHeavyConsumers.length <= 3);

  renderTableRows(
    byId<HTMLTableSectionElement>('heavy-body'),
    4,
    '暂无上下文步骤数据',
    lastHeavyConsumers.slice(0, limit).map((item) => [
      { text: item.stepIndex !== null ? `#${item.stepIndex}` : '--' },
      { text: item.label, cls: 'label-cell', title: item.label },
      { text: fmtTokens(item.tokens) },
      { text: fmtPct(item.pct) },
    ]),
  );
}

function renderContext(ctx: TelemetryContext): void {
  const level = ctx.level || 'ok';
  const lvlEl = byId('ctx-level');
  lvlEl.dataset.level = level;
  lvlEl.textContent =
    level === 'danger' ? '危险 · 建议 /compact' : level === 'warn' ? '预警 (>=80%)' : '正常';

  const compacts = Number(ctx.checkpointCount || 0);
  const compEl = byId('ctx-compacts');
  compEl.textContent = compacts > 0 ? `已压缩 ${compacts} 次` : '压缩 0 次';
  compEl.dataset.level = compacts >= 6 ? 'danger' : compacts >= 3 ? 'warn' : 'ok';

  byId('ctx-pct').textContent = fmtPct(ctx.pct ?? 0);
  byId('ctx-nums').textContent = `${fmtTokens(ctx.used)} / ${fmtTokens(ctx.limit)}`;

  const warnEl = byId('ctx-warn');
  if (level === 'danger') {
    warnEl.className = 'ctx-warn danger';
    warnEl.textContent =
      '上下文占用已达 95% 以上，即将触发自动压缩，建议执行 /compact 或开启新对话。';
  } else if (level === 'warn') {
    warnEl.className = 'ctx-warn';
    warnEl.textContent = '上下文占用已超过 80%，注意控制大文件与冗长命令输出。';
  } else {
    warnEl.className = 'ctx-warn hidden';
  }

  const bar = byId('ctx-bar');
  const groupsEl = byId('ctx-groups');
  bar.replaceChildren();
  groupsEl.replaceChildren();

  const groups = Array.isArray(ctx.groups) ? ctx.groups.filter((g) => g.tokens > 0) : [];
  const denom = ctx.limit > 0 ? ctx.limit : Math.max(ctx.used || 1, 1);

  for (const g of groups) {
    const color = GROUP_COLORS[g.type] || '#94a3b8';
    const seg = document.createElement('div');
    seg.className = 'bar-seg';
    seg.style.width = `${Math.max((g.tokens / denom) * 100, 0.5)}%`;
    seg.style.background = color;
    seg.title = `${GROUP_LABELS[g.name] || g.name}: ${fmtTokens(g.tokens)}`;
    bar.appendChild(seg);

    const item = document.createElement('div');
    item.className = 'bd-item';
    const left = document.createElement('span');
    left.className = 'bd-left';
    const sw = document.createElement('span');
    sw.className = 'bd-swatch';
    sw.style.background = color;
    const nm = document.createElement('span');
    nm.className = 'bd-name';
    nm.textContent = GROUP_LABELS[g.name] || g.name;
    left.appendChild(sw);
    left.appendChild(nm);

    const val = document.createElement('span');
    val.className = 'bd-val';
    val.textContent = fmtTokens(g.tokens);

    item.appendChild(left);
    item.appendChild(val);
    groupsEl.appendChild(item);
  }

  renderHeavyConsumers(ctx.heavyConsumers);
}

function renderSubagents(sub: SubagentSummary | null | undefined): void {
  const items = Array.isArray(sub?.items) ? sub.items : [];
  const count = sub?.count || items.length;
  byId('sub-summary').textContent =
    count > 0 && sub
      ? `${count} 个 · 新输入 ${fmtTokens(sub.totalInputTokens)} · 缓存 ${fmtTokens(sub.totalCacheReadTokens)} · 输出 ${fmtTokens(sub.totalOutputTokens)}`
      : '0 个子代理';

  const hasItems = items.length > 0;
  if (!hasItems) subExpanded = false;
  const subToggle = byId<HTMLButtonElement>('sub-toggle');
  subToggle.classList.toggle('hidden', !hasItems);
  subToggle.textContent = subExpanded ? '收起' : '展开';
  byId('sub-wrap').classList.toggle('hidden', !hasItems || !subExpanded);

  renderTableRows(
    byId<HTMLTableSectionElement>('sub-body'),
    7,
    '当前对话未调用子代理',
    items.map((item) => [
      { text: item.role || item.typeName || 'Subagent', cls: 'label-cell', title: item.conversationId },
      { text: item.model || '--', cls: 'model-cell', title: item.model || '' },
      { text: String(item.turnsCount || 0) },
      { text: fmtTokens(item.inputTokens) },
      { text: fmtTokens(item.cacheReadTokens) },
      { text: fmtTokens(item.outputTokens) },
      { text: fmtTps(item.avgTps) },
    ]),
  );
}

function renderTurns(turns: TurnSummary[], totalCount: number): void {
  byId('turns-count').textContent = `${totalCount || 0} 轮`;
  renderTableRows(
    byId<HTMLTableSectionElement>('turns-body'),
    9,
    '当前会话暂无模型调用记录',
    turns.slice(0, 15).map((turn) => [
      { text: String(turn.index) },
      { text: turn.model || 'Unknown', cls: 'model-cell', title: turn.model || '' },
      { text: fmtTps(turn.tps) },
      { text: fmtSec(turn.ttftSec) },
      { text: fmtTokens(turn.inputTokens) },
      { text: `${fmtTokens(turn.outputTokens)} (${fmtTokens(turn.thinkingTokens)})` },
      { text: fmtPct(turn.cacheHitPct), title: `缓存读取 ${fmtTokens(turn.cacheReadTokens)}` },
      { text: fmtUsd(turn.costUsd) },
      { text: fmtPct(turn.contextPct) },
    ]),
  );
}

function renderTelemetry(payload: TelemetryApiResponse): void {
  if (payload.etag) lastEtag = payload.etag;
  renderCdp(payload.cdp);
  if (payload.unchanged) {
    return;
  }

  const t = payload.telemetry;
  renderConversations(payload.conversations, payload.conversationId);

  if (!t) {
    renderContext({
      used: 0,
      limit: 0,
      pct: 0,
      level: 'ok',
      checkpointCount: 0,
      groups: [],
      heavyConsumers: [],
    });
    byId('kpi-tps').textContent = '--';
    byId('kpi-tps-sub').textContent = '会话均值 --';
    byId('kpi-ttft').textContent = '--';
    byId('kpi-ttft-sub').textContent = '会话中位数 --';
    byId('kpi-in').textContent = '--';
    byId('kpi-in-sub').textContent = '本轮 --';
    byId('kpi-cache').textContent = '--';
    byId('kpi-cache-sub').textContent = '本轮 --';
    byId('kpi-out').textContent = '--';
    byId('kpi-out-sub').textContent = '本轮 -- · 思考 --';
    byId('kpi-cost').textContent = '--';
    byId('kpi-cost-sub').textContent = '未获取到费率';
    renderSubagents(null);
    renderTurns([], 0);
    return;
  }

  renderContext(t.context);

  const latest = t.latest;
  const sess = t.session;
  byId('kpi-tps').textContent = fmtTps(latest?.tps);
  byId('kpi-tps-sub').textContent = `会话均值 ${fmtTps(sess.avgTps)}`;

  byId('kpi-ttft').textContent = fmtSec(latest?.ttftSec);
  byId('kpi-ttft-sub').textContent = `会话中位数 ${fmtSec(sess.medianTtftSec)}`;

  byId('kpi-in').textContent = fmtTokens(sess.totalInputTokens);
  byId('kpi-in-sub').textContent = latest ? `本轮 ${fmtTokens(latest.inputTokens)}` : '本轮 --';

  byId('kpi-cache').textContent = fmtPct(sess.cacheHitPct);
  byId('kpi-cache-sub').textContent =
    `本轮 ${fmtPct(latest?.cacheHitPct)} · 命中 ${fmtTokens(sess.totalCacheReadTokens)}`;

  byId('kpi-out').textContent = fmtTokens(sess.totalOutputTokens);
  byId('kpi-out-sub').textContent = latest
    ? `本轮 ${fmtTokens(latest.outputTokens)} · 累计思考 ${fmtTokens(sess.totalThinkingTokens)}`
    : `累计思考 ${fmtTokens(sess.totalThinkingTokens)}`;

  byId('kpi-cost').textContent = fmtUsd(sess.totalCostUsd);
  if (typeof sess.totalCostUsd === 'number') {
    byId('kpi-cost-sub').textContent =
      `本轮 ${fmtUsd(latest?.costUsd)} · 缓存省 ${fmtUsd(sess.totalCacheSavedUsd)}`;
  } else {
    byId('kpi-cost-sub').textContent =
      t.pricingSource === 'pending' ? '正在同步 models.dev 费率…' : '未匹配到费率 (离线或无定价)';
  }

  renderSubagents(t.subagents);
  renderTurns(Array.isArray(t.turns) ? t.turns : [], sess.turnsCount);
}

async function refresh(force = false): Promise<void> {
  const convId = manualConvId || window.sidecar?.conversationId || '';
  const qs = new URLSearchParams();
  if (convId) qs.set('conversationId', convId);
  if (force) qs.set('refresh', '1');
  else if (lastEtag) qs.set('etag', lastEtag);
  try {
    const data = await apiGet<TelemetryApiResponse>(`/api/telemetry?${qs.toString()}`);
    renderTelemetry(data);
    scheduleNext(!data.unchanged && data.loading ? FAST_POLL_MS : POLL_MS);
  } catch {
    scheduleNext(POLL_MS);
  }
}

function scheduleNext(ms: number): void {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(() => void refresh(false), ms);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh(true);
});

window.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
  if (event.data?.type === 'theme-change') {
    requestAnimationFrame(syncTheme);
  }
});

byId<HTMLSelectElement>('conv-select').addEventListener('change', (e) => {
  manualConvId = (e.currentTarget as HTMLSelectElement).value;
  lastEtag = '';
  void refresh(true);
});

let doneTimer: ReturnType<typeof setTimeout> | undefined;
byId<HTMLButtonElement>('refresh-btn').addEventListener('click', async () => {
  const btn = byId<HTMLButtonElement>('refresh-btn');
  if (btn.disabled) return;
  clearTimeout(doneTimer);
  delete btn.dataset.done;
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    await Promise.all([refresh(true), new Promise((r) => setTimeout(r, 420))]);
    btn.dataset.done = 'true';
    doneTimer = setTimeout(() => {
      delete btn.dataset.done;
    }, 900);
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
});

byId<HTMLButtonElement>('cdp-pill').addEventListener('click', () => {
  byId('cdp-hint').classList.toggle('hidden');
});

byId<HTMLButtonElement>('heavy-toggle').addEventListener('click', () => {
  heavyExpanded = !heavyExpanded;
  renderHeavyConsumers(lastHeavyConsumers);
});

byId<HTMLButtonElement>('sub-toggle').addEventListener('click', () => {
  subExpanded = !subExpanded;
  byId('sub-toggle').textContent = subExpanded ? '收起' : '展开';
  byId('sub-wrap').classList.toggle('hidden', !subExpanded);
});

syncTheme();
void refresh(true);
