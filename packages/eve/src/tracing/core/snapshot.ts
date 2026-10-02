import type { ScopeRecord } from "#tracing/core/scope-lifecycle.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import { capturedScopeData } from "#tracing/core/scope-completion.js";

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
  if (json === undefined || new TextEncoder().encode(json).length > 32768)
    return JSON.parse(
      JSON.stringify({
        ...record,
        version: 1,
        data: capturedScopeData(data, {
          emit: record.capture.emit,
          recordInputs: false,
          recordOutputs: false,
        }),
      }),
    ) as ScopeRecord;
  try {
    return JSON.parse(
      JSON.stringify({ ...record, version: 1, data: JSON.parse(json) }),
    ) as ScopeRecord;
  } catch {
    return JSON.parse(
      JSON.stringify({
        ...record,
        version: 1,
        data: capturedScopeData(data, {
          emit: record.capture.emit,
          recordInputs: false,
          recordOutputs: false,
        }),
      }),
    ) as ScopeRecord;
  }
}
