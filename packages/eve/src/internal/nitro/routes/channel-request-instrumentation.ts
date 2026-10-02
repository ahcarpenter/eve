import {
  type Attributes,
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  trace,
} from "#compiled/@opentelemetry/api/index.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime.js";
import { markAgentTraceContext } from "#tracing/agent-trace-context.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { AGENT_SPAN_NAMES } from "#tracing/agent-span-contract.js";
import { withErrorContent } from "#tracing/error-content-context.js";

/**
 * Stable tracer name for every inbound eve channel HTTP request. Kept
 * low-cardinality and independent of the agent so dashboards can group
 * request spans across deployments.
 */
const TRACER_NAME = "eve.channel";

/**
 * Reads OTel context from an inbound request's `Headers`. Header lookups
 * are case-insensitive, so this is a thin adapter over `Headers.get`.
 */
const headersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier) {
    return [...carrier.keys()];
  },
};

/** Inputs for {@link traceChannelRequest}. */
interface TraceChannelRequestInput {
  readonly request: Request;
  readonly routeKey: string;
}

/**
 * Wraps one inbound channel HTTP request in an OTel `SERVER` span.
 *
 * The span is named for the low-cardinality registered `routeKey`
 * (`"POST /eve/v1/session/:sessionId"`), never the concrete URL, while the
 * `http.route` attribute carries only the path template and
 * `http.request.method` carries the method. It starts from context extracted
 * off the incoming request headers so an upstream `traceparent` becomes its
 * parent and nested channel operations become its descendants.
 *
 * The handler runs inside the span's active context. When it returns, the
 * response status is recorded and a `>= 500` status marks the span as an
 * error. A thrown handler marks failure status, ends the span, and is
 * rethrown; request spans never record exception content. A response without
 * a body ends the span at once. Otherwise the span ends when the body has been
 * read to the end, fails (marking failure status), or is cancelled, so a
 * streamed response's span lasts for the streaming time. It never waits for
 * `event.waitUntil()` work.
 *
 * The body is read inside the span's active context, so spans started while a
 * streamed body is produced are children of the still-open request span. A
 * request span that ended first would leave them under an ended parent, where
 * the bundled `@vercel/otel` span processor ends them early and they then end
 * a second time.
 *
 * Emitting these spans is opt-in: unless authored instrumentation enables it
 * via `traceChannelRequests: true`, the handler runs with no span (`undefined`)
 * and performs no header extraction. The channel dispatcher can still use an
 * already-active platform span for the activation's cross-trace link.
 *
 * This is observability-only: it never changes the response's status, headers,
 * or body bytes and performs no synchronous span export in the request path,
 * adding only minimal in-process tracing overhead.
 */
export async function traceChannelRequest(
  input: TraceChannelRequestInput,
  handler: (span: Span | undefined) => Promise<Response>,
): Promise<Response> {
  if (getInstrumentationRuntime()?.otelSettings?.traceChannelRequests !== true) {
    return await handler(undefined);
  }

  const { request, routeKey } = input;
  const parentContext = propagation.extract(context.active(), request.headers, headersGetter);
  const spanName = AGENT_SPAN_NAMES.channelRequest;
  const span = trace.getTracer(TRACER_NAME).startSpan(
    spanName,
    {
      attributes: {
        ...baseAttributes(request, routeKey),
        ...(spanName === "agent.channel.request" ? agentSpanNamingAttributes(spanName) : undefined),
      },
      kind: SpanKind.SERVER,
    },
    parentContext,
  );
  const activeContext = markAgentTraceContext(
    withErrorContent(trace.setSpan(parentContext, span), false),
  );

  let response: Response;
  try {
    response = await context.with(activeContext, () => handler(span));
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    throw error;
  }

  span.setAttribute("http.response.status_code", response.status);
  if (response.status >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  if (response.body === null) {
    span.end();
    return response;
  }
  return endSpanWithBody(response, response.body, span, activeContext);
}

/**
 * Re-creates `response` around a pass-through of `body` that ends `span`
 * exactly once: when the body is read to the end, fails, or is cancelled.
 */
function endSpanWithBody(
  response: Response,
  body: ReadableStream<Uint8Array>,
  span: Span,
  activeContext: Context,
): Response {
  const reader = body.getReader();
  let cancelled = false;
  const tracedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // The server pulls the body outside the handler's context.
        const { done, value } = await context.with(activeContext, () => reader.read());
        // A cancel settles the pending read as done; the cancel ends the span.
        if (cancelled) return;
        if (done) {
          span.end();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (cancelled) return;
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        span.end();
      }
    },
  });

  return new Response(tracedBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Standard, non-sensitive request attributes known before the channel is
 * resolved. `eve.channel.name` / `eve.channel.kind` are attached later by
 * the caller once the matching channel is known. Never records session
 * ids, tokens, auth or cookie headers, bodies, or query parameters.
 */
function baseAttributes(request: Request, routeKey: string): Attributes {
  const attributes: Attributes = {
    "http.request.method": request.method,
    "http.route": routeTemplate(routeKey),
  };

  const url = parseRequestUrl(request.url);
  if (url !== undefined) {
    attributes["url.scheme"] = url.protocol.replace(/:$/, "");
    attributes["server.address"] = url.hostname;
  }

  return attributes;
}

/**
 * Extracts the path template from a `"METHOD /path/:param"` route key. The
 * OTel HTTP convention keeps `http.route` free of the method so route
 * facets align with other server spans; the method lives in
 * `http.request.method` and the full key remains the span name.
 */
function routeTemplate(routeKey: string): string {
  const separator = routeKey.indexOf(" ");
  return separator === -1 ? routeKey : routeKey.slice(separator + 1);
}

function parseRequestUrl(rawUrl: string): URL | undefined {
  try {
    return new URL(rawUrl);
  } catch {
    return undefined;
  }
}
