- Add one Anthropic (Claude) entry point for server-side callers such as the
  builder agent and the assistant chat box. Every call through it uses prompt
  caching on the system prompt, tools and conversation so far, and logs how
  much came from cache. `npm run anthropic:cache-check` confirms it against the
  live API (Atlas, #6).
