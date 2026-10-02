---
"eve": patch
---

Use shared semantic tracing activation for tools, models, memory, requests, and MCP calls. Nested MCP calls reuse tool operations, capture permissions cannot broaden during activation, and checkpoint IO failures no longer replace application results or errors.
