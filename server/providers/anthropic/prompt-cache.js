// Prompt caching for Anthropic Messages requests.
//
// Caching is a prefix match over tools -> system -> messages: any byte change
// invalidates everything after it. So the stable part of a request (tool
// definitions, the system prompt, long static context) must come first and be
// byte-identical across calls, and anything that changes per call goes after
// the last breakpoint, in `messages`.
//
// withPromptCache() places two breakpoints:
//   1. An explicit marker on the last block of the stable prefix (the last
//      system block, or the last tool when there is no system prompt). It
//      caches tools and system together and survives whatever happens later
//      in the conversation.
//   2. Top-level automatic caching, which caches the growing conversation
//      tail so each turn of a chat or an agent loop reads the previous turns
//      from cache. One-shot calls whose last message is unique every time
//      should pass `cacheTail: false`: caching a tail that is never read again
//      only pays the cache-write premium.
//
// Both breakpoints share one TTL. A 1-hour entry may not follow a 5-minute
// one, and an explicit marker on the last block with a TTL different from the
// top-level field is a 400, so mixing TTLs is not offered.

const PROMPT_CACHE_TTLS = Object.freeze(['5m', '1h']);

const PROMPT_CACHE_TTL_DEFAULT = '5m';

function resolvePromptCacheTtl(value) {
  const ttl = String(value || '')
    .trim()
    .toLowerCase();
  return PROMPT_CACHE_TTLS.includes(ttl) ? ttl : PROMPT_CACHE_TTL_DEFAULT;
}

function cacheControl(ttl) {
  // 5m is the API default; leaving `ttl` off keeps the request bytes the same
  // as a hand-written `{ type: 'ephemeral' }`.
  return ttl === '1h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' };
}

function systemBlocks(system) {
  if (system == null || system === '') return [];
  if (typeof system === 'string') return [{ type: 'text', text: system }];
  if (Array.isArray(system)) return system.map((block) => ({ ...block }));
  throw new TypeError('system must be a string or an array of text blocks');
}

function withLastMarked(blocks, marker) {
  if (!blocks.length) return blocks;
  const marked = blocks.slice();
  marked[marked.length - 1] = {
    ...marked[marked.length - 1],
    cache_control: marker,
  };
  return marked;
}

/**
 * Return a copy of Messages API params with prompt-cache breakpoints placed.
 * The input is not mutated. Existing `cache_control` markers in `messages`
 * are left alone; callers that place their own should count them against the
 * API's four-breakpoint limit (this function uses at most two).
 */
function withPromptCache(params, { ttl, cacheTail = true } = {}) {
  const resolvedTtl = resolvePromptCacheTtl(ttl);
  const marker = cacheControl(resolvedTtl);
  const next = { ...params };

  const system = systemBlocks(params.system);
  const tools = Array.isArray(params.tools)
    ? params.tools.map((tool) => ({ ...tool }))
    : [];

  if (system.length) {
    next.system = withLastMarked(system, marker);
    if (tools.length) next.tools = tools;
  } else if (tools.length) {
    next.tools = withLastMarked(tools, marker);
    delete next.system;
  } else {
    delete next.system;
  }

  if (cacheTail) next.cache_control = marker;
  else delete next.cache_control;
  return next;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Summarise a response's `usage` for logs. `read` tokens came from cache,
 * `written` were stored for later calls, `uncached` were billed at full price.
 */
function promptCacheUsage(usage) {
  const read = count(usage?.cache_read_input_tokens);
  const written = count(usage?.cache_creation_input_tokens);
  const uncached = count(usage?.input_tokens);
  const total = read + written + uncached;
  return {
    read,
    written,
    uncached,
    hitRatio: total ? read / total : 0,
  };
}

function formatPromptCacheUsage(usage) {
  const { read, written, uncached, hitRatio } = promptCacheUsage(usage);
  return `cache read ${read}, written ${written}, uncached ${uncached} (${Math.round(hitRatio * 100)}% from cache)`;
}

export {
  PROMPT_CACHE_TTLS,
  PROMPT_CACHE_TTL_DEFAULT,
  resolvePromptCacheTtl,
  withPromptCache,
  promptCacheUsage,
  formatPromptCacheUsage,
};
