---
"eve": patch
---

Remove redundant internal tracing wrappers and fallback recorder construction. Shared tracing helpers now live with their library owners, while eve uses its installed recorder directly.
