import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MODELS_DEV_URL = 'https://models.dev/api.json';
export const PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const PREFERRED_PROVIDERS = ['google', 'anthropic', 'openai', 'togetherai'];

/**
 * Normalize model identifiers across Antigravity and models.dev.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeModelKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/:(batch|free|nitro|floor|extended)$/i, '')
    .replace(/\((low|medium|high|xhigh)\)/g, '')
    .replace(/-(low|medium|high|xhigh)$/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Build a lookup map from models.dev /api.json (prices in USD per 1M tokens).
 * Prioritizes first-party providers (google, anthropic, openai) over third-party hosts.
 * @param {object} catalog
 * @returns {Map<string, {id: string, prompt: number, completion: number, cacheRead: number}>}
 */
export function buildModelsDevPricingMap(catalog) {
  const map = new Map();
  if (!catalog || typeof catalog !== 'object') return map;

  const allProviders = Object.keys(catalog);
  const orderedProviders = [
    ...PREFERRED_PROVIDERS.filter((p) => catalog[p]),
    ...allProviders.filter((p) => !PREFERRED_PROVIDERS.includes(p)),
  ];

  for (const provId of orderedProviders) {
    const models = catalog[provId]?.models;
    if (!models || typeof models !== 'object') continue;

    for (const [modelId, model] of Object.entries(models)) {
      const cost = model?.cost;
      if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') continue;
      if (cost.input < 0 || cost.output < 0) continue;

      const prompt = cost.input / 1e6;
      const completion = cost.output / 1e6;
      const cacheRead = typeof cost.cache_read === 'number' && cost.cache_read >= 0
        ? cost.cache_read / 1e6
        : prompt;

      const entry = { id: `${provId}/${modelId}`, prompt, completion, cacheRead };
      for (const rawKey of [modelId, model?.name]) {
        const key = normalizeModelKey(rawKey);
        if (key && !map.has(key)) map.set(key, entry);
      }
    }
  }
  return map;
}

/**
 * Resolve per-token rates for a turn's responseModel or modelDisplayName.
 * @param {Map<string, object>|null|undefined} pricingMap
 * @param {string} responseModel
 * @param {string} displayName
 * @returns {{id: string, prompt: number, completion: number, cacheRead: number}|null}
 */
export function resolveModelPrice(pricingMap, responseModel, displayName) {
  if (!pricingMap || !pricingMap.size) return null;
  for (const candidate of [responseModel, displayName]) {
    const key = normalizeModelKey(candidate);
    if (key && pricingMap.has(key)) return pricingMap.get(key);
  }
  return null;
}

/**
 * Compute USD cost for token counts given per-token rates.
 * @param {{inputTokens: number, cacheReadTokens: number, outputTokens: number}} usage
 * @param {{prompt: number, completion: number, cacheRead: number}|null} rate
 * @returns {number|null}
 */
export function computeTurnCostUsd(usage, rate) {
  if (!rate) return null;
  return (
    (usage.inputTokens || 0) * rate.prompt +
    (usage.cacheReadTokens || 0) * rate.cacheRead +
    (usage.outputTokens || 0) * rate.completion
  );
}

/**
 * Persistent 6-hour cached fetcher for models.dev pricing (fails softly when offline).
 */
export class PricingCatalog {
  constructor(cacheFile = null) {
    const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    this.cacheFile = cacheFile ?? (dataDir ? join(dataDir, 'pricing-cache.json') : null);
    this.map = new Map();
    this.fetchedAt = 0;
    this.lastAttemptAt = 0;
    this.inFlight = null;
    this.source = 'pending';
    this.loadDiskCache();
  }

  loadDiskCache() {
    if (!this.cacheFile || !existsSync(this.cacheFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.cacheFile, 'utf-8'));
      if (Array.isArray(saved?.entries) && saved.entries.length > 0) {
        this.map = new Map(saved.entries);
        this.fetchedAt = Number(saved.fetchedAt || 0);
        this.source = 'models.dev';
      }
    } catch {
      // Ignore corrupt cache file.
    }
  }

  saveDiskCache() {
    if (!this.cacheFile || this.map.size === 0) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(
        this.cacheFile,
        JSON.stringify({ fetchedAt: this.fetchedAt, entries: [...this.map.entries()] }),
      );
    } catch {
      // Non-fatal if cache path is unwritable.
    }
  }

  async refreshIfNeeded() {
    const now = Date.now();
    if (this.map.size > 0 && now - this.fetchedAt < PRICING_CACHE_TTL_MS) return this.map;
    if (now - this.lastAttemptAt < RETRY_COOLDOWN_MS) return this.map;
    if (this.inFlight) return this.inFlight;

    this.lastAttemptAt = now;
    this.inFlight = (async () => {
      try {
        const res = await fetch(MODELS_DEV_URL, {
          headers: { 'User-Agent': 'agy-monitor/0.1' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const nextMap = buildModelsDevPricingMap(await res.json());
        if (nextMap.size > 0) {
          this.map = nextMap;
          this.fetchedAt = Date.now();
          this.source = 'models.dev';
          this.saveDiskCache();
        }
      } catch {
        if (this.map.size === 0) this.source = 'unavailable';
      } finally {
        this.inFlight = null;
      }
      return this.map;
    })();

    return this.inFlight;
  }
}
