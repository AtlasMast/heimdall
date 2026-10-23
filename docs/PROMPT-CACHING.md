# Prompt caching (Anthropic)

Every Heimdall call to the Anthropic Messages API goes through
`createAnthropicMessenger()` in `server/providers/anthropic/messenger.js`. It
places prompt-cache breakpoints for you, so repeated calls that share a prompt
read it back from cache instead of paying full input price for it again (cache
reads on Claude Opus 5.5 cost about 5% of normal input).

```js
import { createAnthropicMessenger } from '../server/providers/anthropic/messenger.js';

const claude = createAnthropicMessenger({ label: 'builder' });
const message = await claude.create({
  system: BUILDER_SYSTEM_PROMPT,
  tools: BUILDER_TOOLS,
  messages,
  max_tokens: 16000,
});
// logs: [builder] claude-opus-5-5: cache read 41200, written 380, uncached 95 (99% from cache)
```

Use `claude.stream(...)` for long outputs and `await` its `.finalMessage()`.

## What gets cached

The API caches by exact prefix, in the order tools, then system, then messages.
The messenger places two breakpoints:

1. One on the last system block (or the last tool if there is no system
   prompt). That caches the tool definitions and the system prompt together.
2. Top-level automatic caching, which caches the conversation so far. Each turn
   of a chat or an agent loop then reads all earlier turns from cache.

For a one-shot call whose last message is new every time, pass
`{ cacheTail: false }` as the second argument to `create`, so only the shared
prompt is cached.

## Keeping the cache hitting

A single changed byte before a breakpoint means a cache miss for everything
after it. So:

- Keep the system prompt and tool list byte-identical between calls: no
  timestamps, request ids, or the current map view inside them.
- Build the tool list in a fixed order and don't add or drop tools mid-run.
- Put anything that changes per call (the user's question, current state,
  file contents just read) in `messages`.
- Prompts shorter than the model's minimum (512 tokens on current models) are
  never cached. That is silent; the log just shows `written 0`.

If the log shows `cache read 0` on every call of a run, something in the prefix
is changing.

## Settings

| Variable                     | Default           | Meaning                                                |
| ---------------------------- | ----------------- | ------------------------------------------------------ |
| `ANTHROPIC_API_KEY`          | none              | Server-side secret.                                    |
| `ANTHROPIC_MODEL`            | `claude-opus-5-5` | Model for calls that don't name one.                   |
| `ANTHROPIC_PROMPT_CACHE_TTL` | `5m`              | `1h` for calls usually 5 to 60 minutes apart.          |
| `ANTHROPIC_FALLBACKS`        | on                | `off` stops retrying a refused request on other model. |

## The builder agent

If the builder runs as its own script or service, have it call the messenger as
above. If it runs through Claude Code (the GitHub Action, a cloud session, or
`claude` on playstation), Claude Code already caches its prompt automatically
and there is nothing to add.
