import { createTraceEngine, type TraceOperation } from "#tracing/lib/core/engine.js";
import { identityAttributes, usageAttributes } from "#tracing/lib/core/attributes.js";
import {
  activationAttributes,
  actionAttributes,
  approvalAttributes,
  stepAttributes,
  modelAttributes,
  toolAttributes,
  memoryAttributes,
  invocationName,
  modelName,
  toolName,
  SPAN_NAMES,
  CONTENT_FIELDS,
  applyAttributes,
} from "#tracing/lib/core/contract.js";
import {
  modelInputAttributes,
  modelResultAttributes,
  type ContentSerializer,
} from "#tracing/lib/core/model.js";
import type {
  Attributes,
  CaptureDecision,
  DurableTraceBackend,
  PreparedSpan,
  TraceBackend,
  TraceLink,
  TraceReference,
} from "#tracing/lib/core/types.js";
import { gatewayCostAttributes } from "#tracing/lib/core/gateway.js";
import {
  completeScope,
  capturedScopeData as capturedData,
} from "#tracing/lib/core/scope-completion.js";
import { mcpLifecycle } from "#tracing/lib/core/mcp.js";
import { intersectCapture } from "#tracing/lib/core/activation.js";
import { pendingTool, toolCallRecord, type ToolCallInput } from "#tracing/lib/core/pending-tool.js";
import { accumulateUsage } from "#tracing/lib/core/usage.js";
import { snapshotRecord } from "#tracing/lib/core/snapshot.js";
import { boundedSerializer } from "#tracing/lib/core/serializer.js";
import { withoutDeclinedContent } from "#tracing/lib/core/content-policy.js";
import { runTraceContext } from "#tracing/lib/core/context.js";
import { reservation } from "#tracing/lib/core/reservation.js";

export type {
  StepOptions,
  ModelOptions,
  ActionOptions,
  ApprovalOptions,
  MemoryOptions,
} from "#tracing/lib/core/scope-lifecycle.js";
export type ModelResult = Parameters<typeof modelResultAttributes>[0];
export type { ActionResult, ToolResult } from "#tracing/lib/core/operations.js";

export type {
  ScopeIdentity,
  TurnMetadata,
  ScopeData,
  ScopeRecord,
  RuntimeBinding,
  ScopeTerminal,
  RuntimeScope,
} from "#tracing/lib/core/scope-lifecycle.js";
import type {
  ScopeIdentity,
  ScopeData,
  ScopeRecord,
  RuntimeBinding,
  RuntimeScope,
} from "#tracing/lib/core/scope-lifecycle.js";

export function createTraceLifecycle(input: {
  readonly backend: TraceBackend | DurableTraceBackend;
  readonly serializer: ContentSerializer;
  readonly mode?: "live" | "durable";
  readonly diagnostic?: (code: string) => void;
}) {
  input = { ...input, serializer: boundedSerializer(input.serializer, input.diagnostic) };
  const engine = createTraceEngine(input);
  const backend = input.backend;
  const serializer = input.serializer;
  if (input.mode === "durable" && !("reserveActivation" in backend))
    throw new Error("Durable tracing requires reserved-ID backend support.");
  const scopeLimit = 10_000;

  async function construct(
    identity: ScopeIdentity,
    capture: CaptureDecision,
    data: ScopeData,
    parent: RuntimeScope | undefined,
    attempt: ScopeRecord["attempt"],
    binding: RuntimeBinding,
  ): Promise<RuntimeScope> {
    const key = binding.key;
    const startTimeMs = binding.startTimeMs ?? Date.now();
    const parentReference = parent?.reference ?? binding.parent;
    const actualIdentity = identity;
    capture = intersectCapture(capture, input.backend.active?.()?.capture);
    let actualCapture = capture;
    let actualData = capturedData(data, actualCapture);
    const actualAttempt = attempt;
    const links = binding.links;
    let prepared = prepare(
      actualIdentity,
      actualData,
      actualAttempt,
      actualCapture,
      key,
      parentReference,
      startTimeMs,
      links,
    );
    prepared = { ...prepared, outputContext: binding.outputContext };
    actualData = snapshotRecord(
      {
        key,
        identity: actualIdentity,
        data: actualData,
        capture: actualCapture,
        reference: binding.reference ?? {
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          traceFlags: 0,
        },
        startTimeMs,
      },
      input.serializer,
    ).data;
    const content = binding.content;
    if (actualData.type === "activation" && content !== undefined) {
      prepared = {
        ...prepared,
        attributes: {
          ...prepared.attributes,
          "agent.trace.content.input": content.recordInputs,
          "agent.trace.content.output": content.recordOutputs,
        },
      };
    }
    const durable = input.backend;
    const deferred = binding?.deferred ?? input.mode === "durable";
    let reference = binding.reference;
    if (deferred && reference === undefined) {
      if (!("reserveActivation" in durable))
        throw new Error("Checkpointed trace scopes require reserved-ID backend support.");
      reference =
        data.type === "activation"
          ? durable.reserveActivation({ key, span: prepared, capture: actualCapture })
          : parentReference === undefined
            ? undefined
            : durable.reserveChild(parentReference, key);
    }
    let operation: TraceOperation | undefined = deferred
      ? undefined
      : reference === undefined
        ? engine.start(prepared, actualCapture, binding?.executionContext)
        : engine.startReserved(prepared, reference, actualCapture, binding?.executionContext);
    reference ??= operation?.reference;
    if (reference === undefined)
      throw new Error("A child trace scope requires its constructed parent.");
    const retainedReference = reference;
    actualCapture = {
      emit: actualCapture.emit && (reference.traceFlags & 1) !== 0,
      recordInputs:
        actualCapture.emit && (reference.traceFlags & 1) !== 0 && actualCapture.recordInputs,
      recordOutputs:
        actualCapture.emit && (reference.traceFlags & 1) !== 0 && actualCapture.recordOutputs,
    };
    actualData = capturedData(actualData, actualCapture);
    let finished = false;
    let started = false;
    const children = new Set<RuntimeScope>();
    let childSequence = 0;
    let totalInput: number | undefined;
    let totalOutput: number | undefined;
    const usageKeys = new Set<string>();
    let pendingError: { error?: unknown; errorType?: string } | undefined;
    const enrichment: Record<string, Attributes[string]> = {};
    function requireParent(types: readonly ScopeData["type"][]): void {
      if (finished || !types.includes(actualData.type))
        throw new Error("The operation is not permitted in this trace scope.");
    }
    async function child(
      childData: ScopeData,
      childBinding: RuntimeBinding,
    ): Promise<RuntimeScope> {
      if (childData.type === "step" && actualData.type === "activation")
        childData = {
          ...childData,
          options: { ...childData.options, channel: actualData.options.channel },
        };
      if (children.size >= scopeLimit) {
        for (const previous of children) if (previous.finished) children.delete(previous);
        if (children.size >= scopeLimit)
          throw new Error("The trace scope has too many unfinished child operations.");
      }
      const nextAttempt =
        childData.type === "step"
          ? { index: childData.options.index, attempt: childData.options.attempt ?? 0 }
          : actualAttempt;
      const next = await construct(actualIdentity, actualCapture, childData, runtime, nextAttempt, {
        ...childBinding,
        key: childBinding.key,
        outputContext: childBinding?.outputContext ?? binding?.outputContext,
      });
      if (childData.type === "model")
        runtime.modelSelected(childData.options.modelId, childData.options.provider);
      children.add(next);
      return next;
    }
    const runtime: RuntimeScope = {
      get description() {
        return actualData;
      },
      child(data, childKey) {
        const parents =
          data.type === "step"
            ? ["activation"]
            : data.type === "model" || data.type === "action"
              ? ["step"]
              : data.type === "memory"
                ? ["activation", "step", "action", "tool"]
                : ["action"];
        requireParent(parents as readonly ScopeData["type"][]);
        return child(data, { key: childKey ?? JSON.stringify([key, data.type, childSequence++]) });
      },
      type: actualData.type,
      reference: retainedReference,
      get capture() {
        return actualCapture;
      },
      mcp: mcpLifecycle({
        serializer: input.serializer,
        ...actualCapture,
        write(attributes) {
          const permitted = (withoutDeclinedContent(attributes, actualCapture) ??
            attributes) as Attributes;
          Object.assign(enrichment, permitted);
          if (operation !== undefined) applyAttributes(operation, permitted);
        },
        error(error, type) {
          runtime.error(error, type);
        },
      }),
      get finished() {
        return finished;
      },
      run(execute, ceiling) {
        if (finished) throw new Error("The trace scope has already finished.");
        actualCapture = intersectCapture(
          intersectCapture(actualCapture, ceiling),
          backend.active?.()?.capture,
        );
        actualData = capturedData(actualData, actualCapture);
        if (!actualCapture.recordOutputs && pendingError !== undefined)
          pendingError.error = undefined;
        prepared = {
          ...prepared,
          attributes: (withoutDeclinedContent(prepared.attributes, actualCapture) ??
            prepared.attributes) as Attributes,
        };
        const permitted = withoutDeclinedContent(enrichment, actualCapture) ?? enrichment;
        for (const key of Object.keys(enrichment)) if (!(key in permitted)) delete enrichment[key];
        return runTraceContext(
          backend,
          retainedReference,
          actualCapture,
          execute,
          binding?.executionContext,
          runtime,
        );
      },
      async finish(result = {}) {
        if (finished) return;
        finished = true;
        // Deferred children belong to the runtime scheduler, not the parent lifetime.
        for (const next of children)
          if (!next.finished && !deferred)
            await next.finish({ failed: result.failed, error: result.error, outcome: "abandoned" });
        operation ??= engine.startReserved(
          prepared,
          retainedReference,
          actualCapture,
          binding?.executionContext,
        );
        const terminal =
          actualData.type === "activation" && result.usage === undefined
            ? { ...result, usage: { inputTokens: totalInput, outputTokens: totalOutput } }
            : result;
        try {
          completeScope(
            operation,
            actualData,
            terminal,
            actualCapture,
            startTimeMs,
            input.serializer,
          );
        } catch {
          try {
            input.diagnostic?.("agent.tracing.completion.failed");
          } catch {}
        }
        if (pendingError !== undefined) operation.fail(pendingError.error, pendingError.errorType);
        applyAttributes(operation, enrichment);
        if (actualData.type === "model" && result.model !== undefined)
          await parent?.usage(result.model.usage, key);
        operation.end(result.endTimeMs);
      },
      async started() {
        if (finished || started) return;
        started = true;
        if (operation !== undefined && actualData.type === "step")
          operation.addEvent("step.started", undefined, startTimeMs);
      },
      async usage(usage, callKey) {
        if (callKey !== undefined && usageKeys.has(callKey)) return;
        if (callKey !== undefined) usageKeys.add(callKey);
        if (operation !== undefined) applyAttributes(operation, usageAttributes(usage));
        const total = accumulateUsage(
          { inputTokens: totalInput, outputTokens: totalOutput },
          usage,
        );
        totalInput = total.inputTokens;
        totalOutput = total.outputTokens;
        await parent?.usage(usage, callKey);
      },
      modelSelected(modelId, provider) {
        if (operation !== undefined)
          applyAttributes(operation, {
            "agent.model.id": modelId,
            "agent.model.provider": provider,
          });
      },
      cost(cost) {
        if (operation !== undefined) applyAttributes(operation, gatewayCostAttributes(cost));
      },
      error(error, errorType) {
        pendingError = {
          error: actualCapture.recordOutputs ? error : undefined,
          errorType: errorType ?? (error instanceof Error ? error.name : undefined),
        };
        if (operation !== undefined) operation.fail(pendingError.error, pendingError.errorType);
      },
    };
    await runtime.started();
    return runtime;
  }

  function prepare(
    identity: ScopeIdentity,
    data: ScopeData,
    attempt: ScopeRecord["attempt"],
    capture: CaptureDecision,
    key: string,
    parent: TraceReference | undefined,
    startTimeMs: number,
    links?: readonly TraceLink[],
  ): PreparedSpan {
    const shared = identityAttributes(identity);
    const attempted = {
      turnId: identity.turnId,
      index: attempt?.index ?? 0,
      attempt: attempt?.attempt ?? 0,
    };
    let name: string;
    let attributes: Attributes;
    let kind: PreparedSpan["kind"] = "INTERNAL";
    switch (data.type) {
      case "activation": {
        name = invocationName(identity.agentName);
        const options = data.options;
        attributes = activationAttributes({
          ...options,
          identity: shared,
          framework: identity.framework,
          agentName: identity.agentName,
          turnId: identity.turnId,
          channel: options.channel ?? {},
          subagent: options.subagent ?? false,
          recordInputs: capture.recordInputs,
          recordOutputs: capture.recordOutputs,
          title: capture.recordInputs ? options.title : undefined,
          delivery:
            options.delivery === undefined
              ? undefined
              : {
                  ...options.delivery,
                  input: capture.recordInputs
                    ? input.serializer.json(options.delivery.input)
                    : undefined,
                },
        });
        break;
      }
      case "step":
        name = SPAN_NAMES.step;
        attributes = stepAttributes({
          ...data.options,
          identity: shared,
          framework: identity.framework,
          agentName: identity.agentName,
          attempt: attempted,
        });
        break;
      case "model":
        name = modelName(data.options.modelId);
        kind = "CLIENT";
        attributes = {
          ...modelAttributes({ ...data.options, identity: shared, agentName: identity.agentName }),
          ...(capture.recordInputs && data.options.messages !== undefined
            ? modelInputAttributes(
                { messages: data.options.messages, instructions: data.options.instructions },
                input.serializer,
              )
            : undefined),
        };
        break;
      case "action":
        name = SPAN_NAMES.action;
        kind = data.options.kind === "remote-agent-call" ? "CLIENT" : "INTERNAL";
        attributes = actionAttributes({
          ...data.options,
          kind: data.options.kind ?? "tool-call",
          identity: shared,
          framework: identity.framework,
          attempt: attempted,
        });
        break;
      case "tool":
        name = toolName(data.options.name);
        attributes = toolAttributes({
          ...data.options,
          identity: shared,
          agentName: identity.agentName,
        });
        break;
      case "approval":
        name = SPAN_NAMES.approval;
        attributes = approvalAttributes({
          ...data.options,
          identity: shared,
          framework: identity.framework,
          attempt: attempted,
        });
        break;
      case "memory":
        name = data.options.operation;
        kind = "CLIENT";
        attributes = memoryAttributes({
          ...data.options,
          identity: shared,
          turnId: identity.turnId,
        });
        break;
    }
    const payload: Record<string, Attributes[string]> = {};
    if (capture.recordInputs) {
      if (
        data.type === "action" &&
        data.options.kind !== "subagent-call" &&
        data.options.kind !== "remote-agent-call"
      )
        payload[CONTENT_FIELDS.toolArguments] = input.serializer.json(data.options.arguments);
      if (data.type === "tool")
        payload[CONTENT_FIELDS.toolArguments] = input.serializer.json(data.options.arguments);
      if (data.type === "approval")
        payload[CONTENT_FIELDS.approvalRequest] = input.serializer.json(data.options.request);
    }
    return {
      type: data.type,
      operationId: key,
      name,
      kind,
      attributes: { ...attributes, ...payload },
      parent,
      root: data.type === "activation",
      startTimeMs,
      links,
    };
  }

  return {
    begin(
      identity: ScopeIdentity,
      metadata: import("#tracing/lib/core/scope-lifecycle.js").TurnMetadata,
      capture: CaptureDecision,
      key: string,
    ) {
      return construct(
        identity,
        capture,
        { type: "activation", options: metadata },
        undefined,
        undefined,
        { key },
      );
    },
    active: () => backend.active?.(),
    toolCall(input: ToolCallInput) {
      return pendingTool({
        serializer,
        record: toolCallRecord(input, backend),
        backend,
        executionContext: input.executionContext,
        resolve: (record, options) =>
          construct(record.identity, record.capture, record.data, undefined, record.attempt, {
            key: record.key,
            reference: record.reference,
            parent: record.parent,
            startTimeMs: record.startTimeMs,
            executionContext: options.executionContext,
            outputContext: record.outputContext,
          }),
      });
    },
    run<T>(
      reference: TraceReference,
      capture: CaptureDecision,
      execute: () => T,
      executionContext?: import("#tracing/lib/core/types.js").ExecutionContext,
    ) {
      const active = backend.active?.();
      return runTraceContext(
        backend,
        reference,
        capture,
        execute,
        executionContext,
        active?.reference.spanId === reference.spanId &&
          active.reference.traceId === reference.traceId
          ? active
          : undefined,
      );
    },
    ...reservation(backend, (record) =>
      prepare(
        record.identity,
        record.data,
        record.attempt,
        record.capture,
        record.key,
        record.parent,
        record.startTimeMs,
        record.links,
      ),
    ),
    resolve(
      record: ScopeRecord,
      options: {
        readonly deferred?: boolean;
        readonly executionContext?: import("#tracing/lib/core/types.js").ExecutionContext;
      } = {},
    ) {
      return construct(record.identity, record.capture, record.data, undefined, record.attempt, {
        key: record.key,
        reference: record.reference,
        parent: record.parent,
        startTimeMs: record.startTimeMs,
        links: record.links,
        outputContext: record.outputContext,
        content: record.content,
        deferred: options.deferred,
        executionContext: options.executionContext,
      });
    },
  };
}
