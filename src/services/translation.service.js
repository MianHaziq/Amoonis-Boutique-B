/**
 * Translation service — Azure AI Translator (Microsoft Translator) wrapper.
 *
 * Responsibilities:
 *   - Translate single strings or batches between languages (en ↔ ar by default).
 *   - Auto-detect source language when caller does not specify `from`.
 *   - In-memory LRU cache so repeat strings ("Free shipping") cost nothing.
 *   - Provider-agnostic public surface: callers depend only on translate/translateBatch.
 *   - Soft failure: on any error returns the original input + logs once. Never throws.
 *
 * Provider switch: set TRANSLATION_PROVIDER=none to short-circuit (returns input as-is).
 * Useful for tests, local dev without an Azure key, or a quick emergency kill switch.
 */

const PROVIDER = (process.env.TRANSLATION_PROVIDER || 'azure').toLowerCase();
const AZURE_KEY = process.env.AZURE_TRANSLATOR_KEY || '';
const AZURE_REGION = process.env.AZURE_TRANSLATOR_REGION || 'global';
const AZURE_ENDPOINT = (process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com').replace(/\/+$/, '');
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.TRANSLATION_TIMEOUT_MS || '5000', 10));
const RETRY_ATTEMPTS = Math.max(0, parseInt(process.env.TRANSLATION_RETRY_ATTEMPTS || '1', 10));
const CACHE_MAX = Math.max(100, parseInt(process.env.TRANSLATION_CACHE_MAX || '5000', 10));

// Azure caps: 1000 elements + 50K chars per request. Hold a small safety margin.
const MAX_ITEMS_PER_REQUEST = 100;
const MAX_CHARS_PER_REQUEST = 45000;

const enabled = PROVIDER === 'azure' && !!AZURE_KEY;
let warnedDisabled = false;

function warnDisabledOnce() {
  if (warnedDisabled) return;
  warnedDisabled = true;
  if (PROVIDER === 'none') {
    console.warn('[translation] disabled (TRANSLATION_PROVIDER=none) — admin-supplied content saved as-is.');
  } else if (!AZURE_KEY) {
    console.warn('[translation] AZURE_TRANSLATOR_KEY missing — auto-translation skipped, bilingual fields stay null.');
  }
}

/** Tiny LRU using Map insertion order — re-set on hit to bump recency. */
class LRU {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k);
    this.m.delete(k); this.m.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      this.m.delete(oldest);
    }
  }
}
const cache = new LRU(CACHE_MAX);
const cacheKey = (from, to, text) => `${from || 'auto'}|${to}|${text}`;

function isTranslatableString(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

async function azureTranslateRequest(items, to, from) {
  if (!enabled) {
    warnDisabledOnce();
    // Signal "no translation produced" via `translated: false`. Callers must not
    // write the original text into the destination slot when this is false.
    return items.map((it) => ({ text: it.text, detectedLanguage: null, translated: false }));
  }

  const params = new URLSearchParams({ 'api-version': '3.0', to });
  if (from) params.set('from', from);
  const url = `${AZURE_ENDPOINT}/translate?${params.toString()}`;

  const body = JSON.stringify(items.map((it) => ({ text: it.text })));
  const headers = {
    'Ocp-Apim-Subscription-Key': AZURE_KEY,
    'Ocp-Apim-Subscription-Region': AZURE_REGION,
    'Content-Type': 'application/json',
    'X-ClientTraceId': cryptoRandomId(),
  };

  let lastErr;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Azure Translator ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        // 4xx — bad input/key/quota. Do not retry, fail fast.
        if (res.status >= 400 && res.status < 500) throw err;
        lastErr = err;
      } else {
        const json = await res.json();
        return json.map((row) => ({
          text: row?.translations?.[0]?.text ?? '',
          detectedLanguage: row?.detectedLanguage?.language ?? null,
          translated: true,
        }));
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500) break;
    }
    if (attempt < RETRY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Azure Translator request failed');
}

function cryptoRandomId() {
  // Lightweight trace id (not security-sensitive). Avoids requiring `crypto`.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Translate a single string. On failure or when the provider is disabled, returns
 * `translated: false` and leaves `text` equal to the input — callers must treat that
 * as "no translation available" rather than as the translated value.
 *
 * @returns {Promise<{ text: string, sourceLang: string|null, fromCache: boolean, translated: boolean }>}
 */
async function translate(text, { from = null, to } = {}) {
  if (!to) throw new Error('translate: `to` is required');
  if (!isTranslatableString(text)) return { text: text ?? '', sourceLang: null, fromCache: false, translated: false };

  const key = cacheKey(from, to, text);
  const cached = cache.get(key);
  if (cached !== undefined) return { text: cached.text, sourceLang: cached.sourceLang, fromCache: true, translated: true };

  try {
    const [out] = await azureTranslateRequest([{ text }], to, from);
    if (!out.translated) return { text, sourceLang: null, fromCache: false, translated: false };
    const result = { text: out.text || text, sourceLang: out.detectedLanguage };
    cache.set(key, result);
    return { ...result, fromCache: false, translated: true };
  } catch (e) {
    console.error('[translation] translate failed:', e.message);
    return { text, sourceLang: null, fromCache: false, translated: false };
  }
}

/**
 * Translate many strings in one round-trip when possible. Strings sharing `to` (and `from`)
 * get batched together, results are placed back in the same order as the input array.
 *
 * @param {Array<{ text: string, from?: string|null, to: string }>} requests
 * @returns {Promise<Array<{ text: string, sourceLang: string|null }>>}
 */
async function translateBatch(requests) {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  const results = new Array(requests.length);

  // Group by (from || 'auto', to). Index pending vs cached up front.
  const groups = new Map();
  requests.forEach((req, i) => {
    if (!req || !req.to) { results[i] = { text: req?.text ?? '', sourceLang: null, translated: false }; return; }
    if (!isTranslatableString(req.text)) { results[i] = { text: req.text ?? '', sourceLang: null, translated: false }; return; }
    const key = cacheKey(req.from, req.to, req.text);
    const cached = cache.get(key);
    if (cached !== undefined) { results[i] = { ...cached, translated: true }; return; }
    const g = `${req.from || 'auto'}|${req.to}`;
    if (!groups.has(g)) groups.set(g, { from: req.from || null, to: req.to, items: [] });
    groups.get(g).items.push({ idx: i, text: req.text });
  });

  for (const group of groups.values()) {
    // Chunk by Azure's per-call ceiling.
    for (let start = 0; start < group.items.length; ) {
      const chunk = [];
      let chars = 0;
      while (
        start < group.items.length &&
        chunk.length < MAX_ITEMS_PER_REQUEST &&
        chars + group.items[start].text.length <= MAX_CHARS_PER_REQUEST
      ) {
        chunk.push(group.items[start]);
        chars += group.items[start].text.length;
        start++;
      }
      if (chunk.length === 0) {
        // Single string longer than the per-request char ceiling — send alone (Azure will accept up to 50K).
        chunk.push(group.items[start]); start++;
      }

      try {
        const out = await azureTranslateRequest(
          chunk.map((c) => ({ text: c.text })),
          group.to,
          group.from,
        );
        chunk.forEach((c, j) => {
          const r = out[j] || { text: c.text, detectedLanguage: null, translated: false };
          if (!r.translated) {
            results[c.idx] = { text: c.text, sourceLang: null, translated: false };
            return;
          }
          const value = { text: r.text || c.text, sourceLang: r.detectedLanguage };
          cache.set(cacheKey(group.from, group.to, c.text), value);
          results[c.idx] = { ...value, translated: true };
        });
      } catch (e) {
        console.error('[translation] batch chunk failed:', e.message);
        chunk.forEach((c) => { results[c.idx] = { text: c.text, sourceLang: null, translated: false }; });
      }
    }
  }

  // Fill any still-undefined slots (defensive — shouldn't happen).
  for (let i = 0; i < results.length; i++) {
    if (results[i] === undefined) results[i] = { text: requests[i]?.text ?? '', sourceLang: null, translated: false };
  }
  return results;
}

function isEnabled() { return enabled; }
function getStatus() {
  return {
    provider: PROVIDER,
    enabled,
    region: AZURE_REGION,
    endpoint: AZURE_ENDPOINT,
    timeoutMs: TIMEOUT_MS,
    cacheSize: cache.m.size,
    cacheMax: CACHE_MAX,
  };
}

// Test-only: clear the cache between runs.
function _resetCache() { cache.m.clear(); }

module.exports = {
  translate,
  translateBatch,
  isEnabled,
  getStatus,
  _resetCache,
};
