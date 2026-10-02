---
"eve": patch
---

Require each instrumentation runtime to own its trace ID generator. Session initialization no longer creates fallback generators or trace seeds when no instrumentation runtime is installed.
