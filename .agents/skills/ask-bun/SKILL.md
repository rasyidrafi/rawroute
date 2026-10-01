---
name: ask-bun
description: Ask questions about Bun using the public Bun Docs AI endpoint and return the completed streamed answer. Use when the user asks for Bun documentation, APIs, runtime, package manager, bundler, test runner, or Bun-specific guidance.
---

# Ask Bun

Use the bundled script to query Bun Docs AI. It sends the question to the public
`https://bun.sh/docs/ask` endpoint, consumes its SSE response, waits for the
`done` event, and prints the final answer. The endpoint currently does not
require authentication.

Run:

```bash
python3 .agents/skills/ask-bun/scripts/ask_bun.py "YOUR QUESTION"
```

The script prints the answer and, when available, the source URLs. Do not expose
the raw SSE chunks to the user unless debugging is requested. If the request
fails or the endpoint changes format, report the failure rather than inventing
an answer.

The endpoint is undocumented/public and may impose rate limits or change. Keep
queries focused on Bun and treat the returned sources as the authority.
