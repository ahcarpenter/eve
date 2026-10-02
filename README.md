# eve: a streamed channel response ends workflow spans twice

Minimal reproduction of a fault in [eve](https://github.com/vercel/eve).

With `otel({ traceChannelRequests: true })`, every `GET /eve/v1/session/:sessionId/stream` served through eve's Vercel Workflow world ends the span `workflow.stream.read.connect` twice. OpenTelemetry reports the second `end()` through `diag`, so an app with a diag logger gets one error line per stream request:

```
workflow.stream.read.connect <traceId>-<spanId> - You can only call end() on a span once.
```

The stream itself works. The span is closed early, so its recorded duration is wrong.

## What is here

Created with `npx eve@latest init`, which installed eve 0.70.1. The first commit is the untouched scaffold. The second holds every code change:

| File                            | Change                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent/instrumentation/otel.ts` | New. Turns `traceChannelRequests` on and installs the OpenTelemetry console diag logger at error level.                             |
| `agent/agent.ts`                | The model is the AI SDK's mock model and answers "ok" in process, so no model credential is needed.                                 |
| `agent/channels/eve.ts`         | `auth: none()`, so the two requests below need no token.                                                                            |
| `loopback/world.mjs`            | New, local run only. eve's local Workflow world, with `streams.get()` replaced by eve's own Vercel `streams.get()` against loopback. |
| `loopback/run.mjs`              | New, local run only. Builds, starts, makes the requests and prints the server's log lines.                                          |
| `package.json`                  | Adds `@opentelemetry/api`, the `repro` script and the `#loopback-world` alias.                                                      |

## Reproduce on Vercel

Needs a Vercel account. Needs no model credential.

1. Install and deploy:

   ```bash
   npm install
   npx eve deploy
   ```

2. Create a session and read its stream:

   ```bash
   curl -X POST https://<deployment>/eve/v1/session \
     -H 'content-type: application/json' -d '{"message":"hi"}'
   curl -N --max-time 10 https://<deployment>/eve/v1/session/<sessionId>/stream
   ```

   The first request answers with a `sessionId`. The second prints the session's events from `session.started` to `session.waiting`.

3. Open the deployment's runtime logs. Each stream request leaves one line at level error:

   ```
   workflow.stream.read.connect <traceId>-<spanId> - You can only call end() on a span once.
   ```

The deployment accepts anonymous requests. Its model is a mock and calls no tool, but delete the deployment when you are done.

## Reproduce locally

The span `workflow.stream.read.connect` exists only in eve's Vercel Workflow world. Off Vercel eve uses its local world, which reads streams from disk, and the line does not appear. The local run therefore uses `loopback/world.mjs`: eve's local world for everything except `streams.get()`, which is eve's own unmodified Vercel `streams.get()`. Its HTTP request goes to a server on 127.0.0.1 in the same process, which answers with the stream's bytes from the local world. No request leaves the machine and no credential is read.

```bash
npm install
npm run repro
```

It builds the agent, starts it, creates one session, reads its stream three times and prints the server's log lines. On eve 0.70.1:

```
POST /eve/v1/session -> 202 wrun_01M3Z46RQTV6K482NZMTE4DPNF
GET /eve/v1/session/wrun_01M3Z46RQTV6K482NZMTE4DPNF/stream -> 9 events, session.started to session.waiting
GET /eve/v1/session/wrun_01M3Z46RQTV6K482NZMTE4DPNF/stream -> 9 events, session.started to session.waiting
GET /eve/v1/session/wrun_01M3Z46RQTV6K482NZMTE4DPNF/stream -> 9 events, session.started to session.waiting

--- server log lines with "You can only call end() on a span once."
world.events.create run_started c3d02f75fa8048743c9ab29e29513e80-6584ee96f5a3db7d - You can only call end() on a span once.
world.events.create hook_created c3d02f75fa8048743c9ab29e29513e80-70dbe0c63c00fd5a - You can only call end() on a span once.
workflow.execute workflowEntry c3d02f75fa8048743c9ab29e29513e80-9c512db5022bc83b - You can only call end() on a span once.
workflow.route.flow c3d02f75fa8048743c9ab29e29513e80-a5c0a5f08b5f0932 - You can only call end() on a span once.
workflow.stream.read.connect 82f00097fccdb97dd64916efcb370f38-d6f2d310040fd8b4 - You can only call end() on a span once.
world.events.create run_started 1b36b75fcc4c4965eb0ec54f8157d1fe-529fd9161e21f2bd - You can only call end() on a span once.
workflow.stream.read.connect e304fd107733ff0306e60fb801de9dd0-ea199fa1cbea7ab5 - You can only call end() on a span once.
workflow.execute sessionTimeoutWorkflow 1b36b75fcc4c4965eb0ec54f8157d1fe-64e52ae0758228eb - You can only call end() on a span once.
workflow.route.flow 1b36b75fcc4c4965eb0ec54f8157d1fe-ec36865fe4897160 - You can only call end() on a span once.
workflow.stream.read.connect 5bc9fe0b1adc64cb2980179702246feb-35e3560f8c16145d - You can only call end() on a span once.

world: loopback (Vercel stream reader)
traceChannelRequests: true
stream requests: 3
"workflow.stream.read.connect ... You can only call end() on a span once." lines: 3
```

The three `workflow.stream.read.connect` lines are the fault as a Vercel deployment logs it, one per stream request.

The other lines come from the same fault on another path, and belong to the local run. With a custom world configured, eve runs the workflow in the same process and the same trace as the request that started it. When `workflow.start` ends, the workflow's spans are still open, are ended early and later end themselves.

### Comparisons

| Command                                          | What changes                                   | `workflow.stream.read.connect` lines | Other lines |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------ | ----------- |
| `npm run repro`                                  | nothing                                        | 3 of 3 stream requests               | 7           |
| `REPRO_TRACE_CHANNEL_REQUESTS=false npm run repro` | request spans off                              | 0 of 3                               | 4           |
| `REPRO_LOOPBACK=0 npm run repro`                 | eve's own local world, no Vercel stream reader | 0 of 3                               | 0           |

## What was run

The local run and its two comparisons were run on eve 0.70.1, Node.js 24.21.0, npm 11.19.0, macOS 27.0.1 (arm64).

The Vercel steps were not run from this repository. The line was first seen on a Vercel deployment of a larger app with the same two settings, on eve 0.68.0. The Vercel build of this repository was compiled locally (`VERCEL=1 eve build --skip-sandbox-prewarm`) and not deployed.
