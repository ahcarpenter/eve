import type {
  ActionOptions,
  ApprovalOptions,
  MemoryOptions,
  ModelOptions,
} from "#tracing/core/scope-lifecycle.js";
import type { ModelResult } from "#tracing/core/scopes.js";
import type { MemoryResult } from "#tracing/core/scope-lifecycle.js";

export interface TurnScope {
  attempt<T>(
    options: { stepIndex: number; attempt: number },
    execute: (attempt: StepScope) => Promise<T>,
  ): Promise<T>;
  memory<T>(options: MemoryOptions, execute: () => Promise<MemoryResult<T>>): Promise<T>;
}
export interface StepScope {
  modelCall<T>(
    options: ModelOptions,
    execute: () => Promise<T>,
    describe: (value: T) => ModelResult,
  ): Promise<T>;
  action<T>(
    options: ActionOptions,
    execute: (action: ActionScope) => Promise<T>,
    describe: (value: T) => ActionResult,
  ): Promise<T>;
  memory<T>(options: MemoryOptions, execute: () => Promise<MemoryResult<T>>): Promise<T>;
}
export interface ActionScope {
  toolExecution<T>(
    input: { executionId: string },
    execute: () => Promise<T>,
    describe: (value: T) => ToolResult,
  ): Promise<T>;
  approval<T>(
    options: ApprovalOptions,
    execute: () => Promise<T>,
    describe: (value: T) => { outcome: "approved" | "denied" | "cancelled" },
  ): Promise<T>;
  memory<T>(options: MemoryOptions, execute: () => Promise<MemoryResult<T>>): Promise<T>;
}
export type ToolResult =
  | { outcome: "completed"; output?: unknown }
  | { outcome: "failed"; errorType: string; error?: unknown };
export type ActionResult = ToolResult | { outcome: "rejected" | "cancelled" };
