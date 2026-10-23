import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPromptCacheUsage,
  promptCacheUsage,
  resolvePromptCacheTtl,
  withPromptCache,
} from './prompt-cache.js';
import { createAnthropicMessenger } from './messenger.js';

const tools = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object' },
  },
  {
    name: 'write_file',
    description: 'Write a file',
    input_schema: { type: 'object' },
  },
];
const messages = [{ role: 'user', content: 'Port the ticker.' }];

test('marks the last system block and caches the conversation tail', () => {
  const params = { system: 'You are the Heimdall builder.', tools, messages };
  const cached = withPromptCache(params);
  assert.deepEqual(cached.system, [
    {
      type: 'text',
      text: 'You are the Heimdall builder.',
      cache_control: { type: 'ephemeral' },
    },
  ]);
  // Tools render before system, so the system marker already covers them.
  assert.ok(cached.tools.every((tool) => !tool.cache_control));
  assert.deepEqual(cached.cache_control, { type: 'ephemeral' });
  assert.equal(cached.messages, messages);
});

test('never mutates the caller params, so the prefix stays byte-identical', () => {
  const system = [
    { type: 'text', text: 'Stable rules.' },
    { type: 'text', text: 'Static repo map.' },
  ];
  const params = { system, tools, messages };
  const before = JSON.stringify(params);
  const first = withPromptCache(params);
  const second = withPromptCache(params);
  assert.equal(JSON.stringify(params), before);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.system[0].cache_control, undefined);
  assert.deepEqual(first.system[1].cache_control, { type: 'ephemeral' });
});

test('falls back to the last tool when there is no system prompt', () => {
  const cached = withPromptCache({ tools, messages });
  assert.equal(cached.tools[0].cache_control, undefined);
  assert.deepEqual(cached.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal('system' in cached, false);
});

test('one TTL for both breakpoints; unknown TTLs fall back to 5m', () => {
  const cached = withPromptCache({ system: 'x', messages }, { ttl: '1h' });
  assert.deepEqual(cached.system[0].cache_control, {
    type: 'ephemeral',
    ttl: '1h',
  });
  assert.deepEqual(cached.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(resolvePromptCacheTtl('2h'), '5m');
  assert.equal(resolvePromptCacheTtl(' 1H '), '1h');
});

test('cacheTail false leaves only the stable-prefix marker', () => {
  const cached = withPromptCache(
    { system: 'x', messages, cache_control: { type: 'ephemeral' } },
    { cacheTail: false },
  );
  assert.equal('cache_control' in cached, false);
  assert.deepEqual(cached.system[0].cache_control, { type: 'ephemeral' });
});

test('summarises cache usage from a response', () => {
  const usage = {
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
  };
  assert.deepEqual(promptCacheUsage(usage), {
    read: 900,
    written: 0,
    uncached: 100,
    hitRatio: 0.9,
  });
  assert.equal(
    formatPromptCacheUsage(usage),
    'cache read 900, written 0, uncached 100 (90% from cache)',
  );
  assert.equal(promptCacheUsage(undefined).hitRatio, 0);
});

function fakeClient(calls) {
  const message = {
    model: 'claude-opus-5-5',
    usage: { input_tokens: 10, cache_read_input_tokens: 90 },
  };
  return {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return message;
        },
      },
    },
  };
}

test('messenger applies caching, the default model and refusal fallbacks', async () => {
  const calls = [];
  const logs = [];
  const claude = createAnthropicMessenger({
    client: fakeClient(calls),
    environment: {},
    label: 'builder',
    logger: { info: (line) => logs.push(line) },
  });
  await claude.create({ system: 'rules', tools, messages, max_tokens: 1000 });
  const [sent] = calls;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(sent.cache_control, { type: 'ephemeral' });
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(logs, [
    '[builder] claude-opus-5-5: cache read 90, written 0, uncached 10 (90% from cache)',
  ]);
});

test('messenger reads model, TTL and fallback switches from the environment', () => {
  const claude = createAnthropicMessenger({
    client: fakeClient([]),
    environment: {
      ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_PROMPT_CACHE_TTL: '1h',
      ANTHROPIC_FALLBACKS: 'off',
    },
  });
  const sent = claude.prepare({ system: 'rules', messages });
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.deepEqual(sent.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal('fallbacks' in sent, false);
  assert.equal('betas' in sent, false);
});
