import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_MODEL_DEFAULT,
  ANTHROPIC_FALLBACK_BETA,
} from './constants.js';
import {
  formatPromptCacheUsage,
  resolvePromptCacheTtl,
  withPromptCache,
} from './prompt-cache.js';

function fallbacksEnabled(environment) {
  const value = String(environment.ANTHROPIC_FALLBACKS || '')
    .trim()
    .toLowerCase();
  return value !== 'off' && value !== '0' && value !== 'false';
}

/**
 * One place every Heimdall caller of the Anthropic Messages API goes through
 * (the assistant chat box, the builder agent, anything later), so each one
 * gets prompt caching, the same model default and the same usage log without
 * repeating it.
 *
 *   const claude = createAnthropicMessenger({ label: 'builder' });
 *   const message = await claude.create({
 *     system: BUILDER_SYSTEM_PROMPT, // byte-identical on every call
 *     tools: BUILDER_TOOLS,          // same tools, same order
 *     messages,                      // the only part that changes
 *     max_tokens: 16000,
 *   });
 *
 * `cacheTail: false` (per call or per messenger) is for one-shot calls whose
 * last message is new every time; see prompt-cache.js.
 *
 * Refusal fallbacks are on by default (ANTHROPIC_FALLBACKS=off disables
 * them): if the model declines, the API retries the same request on a
 * fallback model inside the same call. Caches are per model, so a fallback
 * turn reads no cache.
 */
function createAnthropicMessenger({
  client,
  environment = process.env,
  model,
  ttl,
  cacheTail = true,
  label = 'anthropic',
  logger = console,
} = {}) {
  const anthropic =
    client || new Anthropic({ apiKey: environment.ANTHROPIC_API_KEY });
  const defaultModel =
    model || environment.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULT;
  const defaultTtl = resolvePromptCacheTtl(
    ttl || environment.ANTHROPIC_PROMPT_CACHE_TTL,
  );
  const withFallbacks = fallbacksEnabled(environment);

  function prepare(params, options = {}) {
    const cached = withPromptCache(
      { model: defaultModel, ...params },
      {
        ttl: options.ttl || defaultTtl,
        cacheTail: options.cacheTail ?? cacheTail,
      },
    );
    if (!withFallbacks || cached.fallbacks !== undefined) return cached;
    const betas = new Set(cached.betas || []);
    betas.add(ANTHROPIC_FALLBACK_BETA);
    return { ...cached, betas: [...betas], fallbacks: 'default' };
  }

  function logUsage(message) {
    if (!message?.usage) return;
    logger.info?.(
      `[${label}] ${message.model || defaultModel}: ${formatPromptCacheUsage(message.usage)}`,
    );
  }

  return {
    prepare,

    async create(params, options = {}) {
      const message = await anthropic.beta.messages.create(
        prepare(params, options),
        options.request,
      );
      logUsage(message);
      return message;
    },

    /** Streams; await `.finalMessage()` on the result for the whole message. */
    stream(params, options = {}) {
      const stream = anthropic.beta.messages.stream(
        prepare(params, options),
        options.request,
      );
      stream.on?.('finalMessage', logUsage);
      return stream;
    },
  };
}

export { createAnthropicMessenger };
