---
"eve": patch
---

Wrapped model calls return a typed envelope containing the application result and completed response metadata. Streaming model calls return immediately and record output messages and usage when their completion promise settles; parent spans wait for pending streams.
