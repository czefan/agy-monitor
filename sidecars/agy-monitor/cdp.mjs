import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UUID_RE } from './telemetry.mjs';

/**
 * Candidate DevToolsActivePort file locations for Antigravity Desktop across OSes.
 * @returns {string[]}
 */
function getDevToolsPortPaths() {
  const paths = [];
  if (process.env.APPDATA) {
    paths.push(join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'));
  }
  const home = homedir();
  paths.push(
    join(home, '.config', 'Antigravity', 'DevToolsActivePort'),
    join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
  );
  return paths;
}

/**
 * Read active CDP port from Antigravity's DevToolsActivePort file if present.
 * @returns {{port: number, browserPath: string, file: string}|null}
 */
export function readDevToolsActivePort() {
  for (const file of getDevToolsPortPaths()) {
    if (!existsSync(file)) continue;
    try {
      const lines = readFileSync(file, 'utf-8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const port = Number.parseInt(lines[0], 10);
      if (Number.isFinite(port) && port > 0 && port < 65536) {
        return { port, browserPath: lines[1] || '', file };
      }
    } catch {
      // Ignore unreadable port file.
    }
  }
  return null;
}

/**
 * Pure-DOM (zero innerHTML, Trusted-Types safe) composer-bar capsule payload.
 * Runs inside the Electron renderer via Runtime.evaluate.
 */
const CAPSULE_SCRIPT = `(() => {
  const VERSION = 1;
  if (window.__agyMonitor?.version === VERSION) {
    return {
      mounted: Boolean(document.getElementById('agy-monitor-capsule-root')?.isConnected),
      convId: window.__agyMonitor.getConvId(),
    };
  }

  const ROOT_ID = 'agy-monitor-capsule-root';
  const POPOVER_ID = 'agy-monitor-capsule-popover';
  const STYLE_ID = 'agy-monitor-capsule-style';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RING_R = 5;
  const RING_C = 2 * Math.PI * RING_R;

  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(POPOVER_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + ROOT_ID + ' { position: relative; display: inline-flex; align-items: center; font-family: inherit; font-variant-numeric: tabular-nums; z-index: 9999; }',
      '.agy-mon-pill { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border-radius: 9999px; font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer; border: none; background: transparent; color: var(--secondary-foreground, inherit); user-select: none; transition: background 120ms ease, color 120ms ease; }',
      '.agy-mon-pill:hover { background: var(--secondary, rgba(128,128,128,0.14)); color: var(--foreground, inherit); }',
      '.agy-mon-ring { width: 14px; height: 14px; flex-shrink: 0; transform: rotate(-90deg); }',
      '.agy-mon-ring-track { fill: none; stroke: currentColor; stroke-opacity: 0.22; stroke-width: 2.2; }',
      '.agy-mon-ring-arc { fill: none; stroke: #10b981; stroke-width: 2.2; stroke-linecap: round; transition: stroke-dashoffset 200ms ease, stroke 200ms ease; }',
      '.agy-mon-pill[data-level="warn"] .agy-mon-ring-arc { stroke: #f59e0b; }',
      '.agy-mon-pill[data-level="danger"] .agy-mon-ring-arc { stroke: #ef4444; }',
      '#' + POPOVER_ID + ' { position: fixed; left: 8px; top: 8px; width: max-content; min-width: 286px; max-width: calc(100vw - 16px); padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(128,128,128,0.25); background: var(--background, #18181b); color: var(--foreground, #f4f4f5); box-shadow: 0 8px 24px rgba(0,0,0,0.22); font-size: 12px; line-height: 1.5; display: none; z-index: 99999; font-variant-numeric: tabular-nums; }',
      '#' + POPOVER_ID + '[data-open="true"] { display: block; }',
      '.agy-mon-pop-grid { display: grid; grid-template-columns: auto auto; justify-content: space-between; gap: 6px 18px; }',
      '.agy-mon-pop-k { opacity: 0.72; white-space: nowrap; }',
      '.agy-mon-pop-v { font-weight: 500; text-align: right; white-space: nowrap; }'
    ].join('\\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function detectDarkTheme() {
    const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
    const nums = (bg.match(/[\\d.]+/g) || []).map(Number);
    if (nums.length < 3) return true;
    const scale = bg.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 0.5;
  }

  function findComposerHost() {
    const footer = document.querySelector('.agy-composer-footer');
    if (footer) {
      const modeBtn = Array.from(footer.querySelectorAll('button')).find((b) =>
        /Turbo|Safe|Ask|Local|Permissions|Plan|Fast/i.test(b.textContent || ''),
      );
      if (modeBtn?.parentElement) {
        return { el: modeBtn.parentElement, before: modeBtn };
      }
      if (footer.children.length >= 2) {
        const rightGroup = footer.children[footer.children.length - 1];
        return { el: rightGroup, before: rightGroup.firstElementChild };
      }
      return { el: footer, before: null };
    }

    const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
      .filter((el) => el.offsetParent !== null);
    for (const input of inputs) {
      let cur = input.parentElement;
      for (let depth = 0; cur && depth < 6; depth += 1) {
        const buttons = cur.querySelectorAll('button');
        if (buttons.length >= 2) {
          const bar = cur.querySelector('[class*="footer"], [class*="toolbar"], [class*="actions"]') || buttons[0].parentElement;
          if (bar) return { el: bar, before: null };
        }
        cur = cur.parentElement;
      }
    }
    return null;
  }

  function fmtNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function positionPopover(pill, pop) {
    if (!pill || !pop || pop.getAttribute('data-open') !== 'true') return;
    const rect = pill.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - popRect.width, window.innerWidth - popRect.width - 8));
    const top = rect.top - popRect.height - 8 >= 8
      ? rect.top - popRect.height - 8
      : Math.min(rect.bottom + 8, window.innerHeight - popRect.height - 8);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function ensureMounted() {
    const host = findComposerHost();
    let root = document.getElementById(ROOT_ID);
    let pop = document.getElementById(POPOVER_ID);
    if (!host || !host.el) {
      if (root) root.remove();
      if (pop) pop.remove();
      return null;
    }

    injectStyle();
    if (!pop) {
      pop = document.createElement('div');
      pop.id = POPOVER_ID;
      pop.setAttribute('data-open', 'false');
      document.body.appendChild(pop);
    }
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'agy-mon-pill';
      pill.setAttribute('data-level', 'ok');

      const ring = document.createElementNS(SVG_NS, 'svg');
      ring.setAttribute('class', 'agy-mon-ring');
      ring.setAttribute('viewBox', '0 0 14 14');
      ring.setAttribute('aria-hidden', 'true');

      const track = document.createElementNS(SVG_NS, 'circle');
      track.setAttribute('class', 'agy-mon-ring-track');
      track.setAttribute('cx', '7');
      track.setAttribute('cy', '7');
      track.setAttribute('r', String(RING_R));

      const arc = document.createElementNS(SVG_NS, 'circle');
      arc.setAttribute('class', 'agy-mon-ring-arc');
      arc.setAttribute('cx', '7');
      arc.setAttribute('cy', '7');
      arc.setAttribute('r', String(RING_R));
      arc.setAttribute('stroke-dasharray', RING_C.toFixed(2));
      arc.setAttribute('stroke-dashoffset', RING_C.toFixed(2));

      ring.appendChild(track);
      ring.appendChild(arc);

      const text = document.createElement('span');
      text.textContent = '-- t/s';

      pill.appendChild(ring);
      pill.appendChild(text);

      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = pop.getAttribute('data-open') === 'true';
        if (!open) {
          const dark = detectDarkTheme();
          if (!getComputedStyle(document.documentElement).getPropertyValue('--background').trim()) {
            pop.style.background = dark ? '#18181b' : '#faf9f5';
            pop.style.color = dark ? '#f4f4f5' : '#18181b';
          }
        }
        pop.setAttribute('data-open', open ? 'false' : 'true');
        if (!open) positionPopover(pill, pop);
      });

      document.addEventListener('click', (e) => {
        if (!root.contains(e.target) && !pop.contains(e.target)) {
          pop.setAttribute('data-open', 'false');
        }
      });

      window.addEventListener('resize', () => positionPopover(pill, pop));

      root.appendChild(pill);
    }

    if (host.before && host.before.parentElement === host.el) {
      if (root.parentElement !== host.el || root.nextElementSibling !== host.before) {
        host.el.insertBefore(root, host.before);
      }
    } else if (root.parentElement !== host.el) {
      host.el.appendChild(root);
    }
    return root;
  }

  function setRows(pop, rows) {
    pop.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'agy-mon-pop-grid';
    for (const [k, v] of rows) {
      const kl = document.createElement('span');
      kl.className = 'agy-mon-pop-k';
      kl.textContent = k;
      const vl = document.createElement('span');
      vl.className = 'agy-mon-pop-v';
      vl.textContent = v;
      grid.appendChild(kl);
      grid.appendChild(vl);
    }
    pop.appendChild(grid);
  }

  function getConvId() {
    const m = (location.href || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : '';
  }

  window.__agyMonitor = {
    version: VERSION,
    getConvId,
    update(data) {
      const root = ensureMounted();
      if (!root) return;
      const pill = root.querySelector('.agy-mon-pill');
      const arc = pill.querySelector('.agy-mon-ring-arc');
      const label = pill.querySelector('span:last-child');
      const pop = document.getElementById(POPOVER_ID);

      const pct = Math.max(0, Math.min(100, Number(data?.context?.pct || 0)));
      const level = pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : 'ok';
      const tps = data?.latest?.tps;
      const avgTps = data?.session?.avgTps;
      const ttft = data?.latest?.ttftSec;
      const medTtft = data?.session?.medianTtftSec;
      const latestCachePct = data?.latest?.cacheHitPct;
      const cachePct = data?.session?.cacheHitPct;

      pill.setAttribute('data-level', level);
      pill.title = '上下文 ' + pct.toFixed(1) + '% · 点击查看详情';
      if (arc) {
        arc.setAttribute('stroke-dashoffset', (RING_C * (1 - pct / 100)).toFixed(2));
      }
      label.textContent = typeof tps === 'number' ? tps.toFixed(0) + ' t/s' : '-- t/s';

      const fmtUsd = (v) => (typeof v !== 'number' ? '--' : (v > 0 && v < 0.01 ? '$' + v.toFixed(4) : '$' + v.toFixed(2)));
      const usedStr = fmtNum(data?.context?.used || 0);
      const limitStr = fmtNum(data?.context?.limit || 0);
      const compacts = Number(data?.context?.checkpointCount || 0);
      const ctxText = (limitStr !== '0' ? usedStr + ' / ' + limitStr : usedStr) + ' · ' + pct.toFixed(1) + '%';
      setRows(pop, [
        ['上下文窗口', ctxText + (compacts > 0 ? ' (压缩 ' + compacts + ' 次)' : '')],
        ['本轮 / 平均 TPS', (typeof tps === 'number' ? tps.toFixed(1) : '--') + ' / ' + (typeof avgTps === 'number' ? avgTps.toFixed(1) : '--') + ' tok/s'],
        ['本轮 / 中位 TTFT', (typeof ttft === 'number' ? ttft.toFixed(2) : '--') + ' / ' + (typeof medTtft === 'number' ? medTtft.toFixed(2) : '--') + ' s'],
        ['本轮 / 累计缓存', (typeof latestCachePct === 'number' ? latestCachePct.toFixed(1) + '%' : '--') + ' / ' + (typeof cachePct === 'number' ? cachePct.toFixed(1) + '%' : '--')],
        ['本轮 / 累计费用', fmtUsd(data?.latest?.costUsd) + ' / ' + fmtUsd(data?.session?.totalCostUsd)],
      ]);
      positionPopover(pill, pop);
    },
  };

  const root = ensureMounted();
  return { mounted: Boolean(root?.isConnected), convId: getConvId() };
})();`;

/**
 * Minimal CDP WebSocket client using Node's built-in WebSocket.
 */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP WebSocket connect timeout'));
      }, 3000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket error'));
      });
      ws.addEventListener('close', () => {
        for (const { reject: rej, timer: t } of this.pending.values()) {
          clearTimeout(t);
          rej(new Error('CDP WebSocket closed'));
        }
        this.pending.clear();
        if (this.ws === ws) this.ws = null;
      });
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
            else entry.resolve(msg.result);
          }
        } catch {
          // Ignore malformed CDP message.
        }
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async evaluate(expression) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP evaluate timeout'));
      }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore.
    }
    this.ws = null;
  }
}

/**
 * Extract only the scalar fields consumed by the composer capsule.
 * @param {object} payload
 */
function buildCapsulePayload(payload) {
  return {
    context: {
      used: payload?.context?.used || 0,
      limit: payload?.context?.limit || 0,
      pct: payload?.context?.pct || 0,
      checkpointCount: payload?.context?.checkpointCount || 0,
    },
    latest: {
      tps: payload?.latest?.tps ?? null,
      ttftSec: payload?.latest?.ttftSec ?? null,
      cacheHitPct: payload?.latest?.cacheHitPct ?? null,
      costUsd: payload?.latest?.costUsd ?? null,
    },
    session: {
      avgTps: payload?.session?.avgTps ?? null,
      medianTtftSec: payload?.session?.medianTtftSec ?? null,
      cacheHitPct: payload?.session?.cacheHitPct ?? null,
      totalCostUsd: payload?.session?.totalCostUsd ?? null,
    },
  };
}

/**
 * Manages optional CDP composer-bar capsule attachment without modifying app.asar.
 */
export class CapsuleManager {
  constructor(getTelemetryForConv) {
    this.getTelemetryForConv = getTelemetryForConv;
    this.clients = new Map();
    this.lastPushedByTarget = new Map();
    this.lastPortCheckAt = 0;
    this.status = { state: 'checking', port: null, targets: 0, detail: 'Initializing' };
  }

  async tick(fallbackConvId) {
    const now = Date.now();
    if (this.status.state === 'port_not_enabled' && now - this.lastPortCheckAt < 10_000) {
      return this.status;
    }
    this.lastPortCheckAt = now;
    const portInfo = readDevToolsActivePort();
    if (!portInfo) {
      this.closeAll();
      this.status = {
        state: 'port_not_enabled',
        port: null,
        targets: 0,
        detail: 'DevToolsActivePort not found (--remote-debugging-port=0 not enabled)',
      };
      return this.status;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${portInfo.port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = (await res.json()).filter(
        (t) =>
          t.type === 'page' &&
          t.webSocketDebuggerUrl &&
          !String(t.url || '').startsWith('devtools://') &&
          !String(t.url || '').startsWith('data:'),
      );

      if (!targets.length) {
        this.closeAll();
        this.status = { state: 'no_target', port: portInfo.port, targets: 0, detail: 'No Antigravity page target' };
        return this.status;
      }

      const activeIds = new Set(targets.map((t) => t.id));
      for (const [id, client] of this.clients.entries()) {
        if (!activeIds.has(id)) {
          client.close();
          this.clients.delete(id);
          this.lastPushedByTarget.delete(id);
        }
      }

      let mountedCount = 0;
      for (const target of targets) {
        let client = this.clients.get(target.id);
        if (!client) {
          client = new CdpClient(target.webSocketDebuggerUrl);
          this.clients.set(target.id, client);
        }
        try {
          const evalRes = await client.evaluate(CAPSULE_SCRIPT);
          const meta = evalRes?.result?.value || {};
          const convId = UUID_RE.test(meta.convId) ? meta.convId : fallbackConvId;
          if (convId) {
            const payload = await this.getTelemetryForConv(convId);
            if (payload) {
              const serialized = JSON.stringify(buildCapsulePayload(payload));
              if (!meta.mounted || this.lastPushedByTarget.get(target.id) !== serialized) {
                await client.evaluate(`window.__agyMonitor?.update(${serialized});`);
                this.lastPushedByTarget.set(target.id, serialized);
              }
            }
          }
          mountedCount += 1;
        } catch {
          client.close();
          this.clients.delete(target.id);
          this.lastPushedByTarget.delete(target.id);
        }
      }

      this.status = {
        state: mountedCount > 0 ? 'attached' : 'no_target',
        port: portInfo.port,
        targets: mountedCount,
        detail: mountedCount > 0 ? `Attached to ${mountedCount} window(s)` : 'Failed to inject capsule',
      };
      return this.status;
    } catch (err) {
      this.closeAll();
      this.status = { state: 'error', port: portInfo.port, targets: 0, detail: err.message };
      return this.status;
    }
  }

  closeAll() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.lastPushedByTarget.clear();
  }
}
