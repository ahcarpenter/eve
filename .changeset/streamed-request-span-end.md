---
"eve": patch
---

With `otel({ traceChannelRequests: true })`, streamed channel responses such as the session event stream no longer end `workflow.stream.read.connect` twice or log "You can only call end() on a span once." The `agent.channel.request` span now ends when the response body has been sent, has failed, or was cancelled, so on streamed responses it lasts for the streaming time, as server spans usually do, and both its duration and the stream spans' durations are accurate. Spans of a workflow that runs in the same process and trace as the request that started it can still be ended early; that case is not changed here.
