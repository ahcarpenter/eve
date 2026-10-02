import type { ScopeRecord } from "#tracing/core/scope-lifecycle.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import { capturedScopeData } from "#tracing/core/scope-completion.js";

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
