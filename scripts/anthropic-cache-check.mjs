// Confirms prompt caching works against the live Anthropic API.
//
//   npm run anthropic:cache-check
//
// Sends the same ~2k-token prompt twice with max_tokens 0, which runs only
// the prompt (no output tokens are billed). The first call should write the
// cache and the second should read it. Costs well under a cent.
import { createAnthropicMessenger } from '../server/providers/anthropic/messenger.js';
import { promptCacheUsage } from '../server/providers/anthropic/prompt-cache.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

const system = Array.from(
  { length: 120 },
  (_, i) =>
    `Rule ${i + 1}: Heimdall layers report their source and freshness honestly.`,
).join('\n');

const claude = createAnthropicMessenger({
  label: 'cache-check',
  environment: { ...process.env, ANTHROPIC_FALLBACKS: 'off' },
});

const results = [];
for (const attempt of ['first', 'second']) {
  const message = await claude.create(
    {
      system,
      messages: [{ role: 'user', content: 'Ready.' }],
      max_tokens: 0,
    },
    { cacheTail: false },
  );
  results.push({ attempt, ...promptCacheUsage(message.usage) });
}

console.table(results);
const ok = results[0].written + results[0].read > 0 && results[1].read > 0;
console.log(
  ok
    ? 'PASS: the second call read the prompt from cache.'
    : 'FAIL: the second call did not read from cache.',
);
process.exit(ok ? 0 : 1);
