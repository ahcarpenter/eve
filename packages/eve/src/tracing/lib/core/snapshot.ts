import type { ScopeRecord } from "#tracing/lib/core/scope-lifecycle.js";
import type { ContentSerializer } from "#tracing/lib/core/model.js";
import { capturedScopeData } from "#tracing/lib/core/scope-completion.js";

export function validSnapshot(value: unknown, requireVersion = true): value is ScopeRecord {
  try {
    if (typeof value !== "object" || value === null) return false;
    const record = value as ScopeRecord;
    if (requireVersion && record.version !== 1) return false;
    if (
      typeof record.key !== "string" ||
      typeof record.startTimeMs !== "number" ||
      !Number.isFinite(record.startTimeMs)
    )
      return false;
    if (record.reference.traceFlags !== 0 && record.reference.traceFlags !== 1) return false;
    if (
      record.reference.tracestate !== undefined &&
      (typeof record.reference.tracestate !== "string" || record.reference.tracestate.length > 512)
    )
      return false;
    if (
      record.parent !== undefined &&
      (!/^[a-f0-9]{32}$/u.test(record.parent.traceId) ||
        !/^[a-f0-9]{16}$/u.test(record.parent.spanId))
    )
      return false;
    if (
      ![
        record.identity.conversationId,
        record.identity.runId,
        record.identity.turnId,
        record.identity.framework.name,
        record.identity.framework.version,
      ].every((v) => typeof v === "string")
    )
      return false;
    const options = record.data.options as Record<string, unknown>;
    switch (record.data.type) {
      case "activation":
        if (!Number.isSafeInteger(options.sequence)) return false;
        break;
      case "step":
        if (!Number.isSafeInteger(options.index)) return false;
        break;
      case "model":
        if (typeof options.provider !== "string" || typeof options.modelId !== "string")
          return false;
        break;
      case "tool":
      case "action":
        if (typeof options.callId !== "string" || typeof options.name !== "string") return false;
        break;
      case "approval":
        if (
          typeof options.requestId !== "string" ||
          typeof options.callId !== "string" ||
          typeof options.actionName !== "string"
        )
          return false;
        break;
      case "memory":
        if (
          (options.operation !== "search_memory" && options.operation !== "upsert_memory") ||
          ![options.phase, options.slot, options.storeId].every((v) => typeof v === "string")
        )
          return false;
        break;
    }
    if (
      !/^[a-f0-9]{32}$/u.test(record.reference.traceId) ||
      !/^[a-f0-9]{16}$/u.test(record.reference.spanId) ||
      typeof record.reference.traceFlags !== "number"
    )
      return false;
    if (
      ![record.capture.emit, record.capture.recordInputs, record.capture.recordOutputs].every(
        (v) => typeof v === "boolean",
      )
    )
      return false;
    if (
      !["activation", "step", "model", "action", "tool", "approval", "memory"].includes(
        record.data.type,
      ) ||
      typeof record.data.options !== "object" ||
      record.data.options === null
    )
      return false;
    if (requireVersion && new TextEncoder().encode(JSON.stringify(record)).length > 65536)
      return false;
    return true;
  } catch {
    return false;
  }
}

export function snapshotRecord(record: ScopeRecord, serializer: ContentSerializer): ScopeRecord {
  const data = capturedScopeData(record.data, record.capture);
  let json: string | undefined;
  try {
    json = serializer.json(data);
  } catch {}
  const fallback = () => {
    let structural = capturedScopeData(data, {
      emit: record.capture.emit,
      recordInputs: false,
      recordOutputs: false,
    });
    if (structural.type === "step")
      structural = { ...structural, options: { ...structural.options, runtimeContext: undefined } };
    if (structural.type === "model")
      structural = { ...structural, options: { ...structural.options, runtimeContext: undefined } };
    return JSON.parse(JSON.stringify({ ...record, version: 1, data: structural })) as ScopeRecord;
  };
  if (json === undefined || new TextEncoder().encode(json).length > 32768) return fallback();
  try {
    const snapshot = JSON.parse(
      JSON.stringify({ ...record, version: 1, data: JSON.parse(json) }),
    ) as ScopeRecord;
    return new TextEncoder().encode(JSON.stringify(snapshot)).length <= 65536
      ? snapshot
      : fallback();
  } catch {
    return fallback();
  }
}
