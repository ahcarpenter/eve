---
"eve": patch
---

Move trace ID reservation inside library operation construction. eve persists references returned by tracing operations instead of allocating action, approval, attempt, or memory span IDs.
