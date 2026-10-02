import type { ExecutionContext, TraceReference, TraceLink, Usage } from "#tracing/core/types.js";
import type { ModelResult, TurnScope, StepScope, ActionScope } from "#tracing/core/scopes.js";
import type { CaptureDecision } from "#tracing/core/types.js";
import type { McpLifecycle } from "#tracing/core/mcp.js";
import type { RunIdentity, FrameworkIdentity } from "#tracing/core/types.js";

export type ScopeData =
  | { readonly type: "activation"; readonly options: TurnMetadata }
  | { readonly type: "step"; readonly options: StepOptions }
  | { readonly type: "model"; readonly options: ModelOptions }
  | { readonly type: "action"; readonly options: ActionOptions }
  | {
      readonly type: "tool";
      readonly options: {
        readonly callId: string;
        readonly name: string;
        readonly arguments?: unknown;
      };
    }
  | {
      readonly type: "approval";
      readonly options: ApprovalOptions & { readonly callId: string; readonly actionName: string };
    }
  | { readonly type: "memory"; readonly options: MemoryOptions };

export interface ScopeIdentity extends RunIdentity {
  readonly agentName?: string;
  readonly framework: FrameworkIdentity;
}

/** Runtime-owned state. Authoring scopes never expose a checkpoint or raw span. */
export interface ScopeRecord {
  readonly key: string;
  readonly identity: ScopeIdentity;
  readonly data: ScopeData;
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly attempt?: { readonly index: number; readonly attempt: number };
  readonly capture: CaptureDecision;
  readonly startTimeMs: number;
  readonly links?: readonly TraceLink[];
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly childIndex?: number;
  readonly stepIndex?: number;
  readonly outputContext?: Readonly<Record<string, string>>;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
}

export interface RuntimeScope {
  readonly type: ScopeData["type"];
  readonly reference: TraceReference;
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  readonly authoring: TurnScope | StepScope | ActionScope;
  step(options: StepOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  model(options: ModelOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  action(options: ActionOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  tool(binding?: RuntimeBinding): Promise<RuntimeScope>;
  approval(options: ApprovalOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  memory(options: MemoryOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  finish(result?: ScopeTerminal): Promise<void>;
  started(): Promise<void>;
  completed(result?: ScopeTerminal): Promise<void>;
  failed(error: unknown): Promise<void>;
  abandon(): void;
  usage(usage: Usage): Promise<void>;
  nextStep(): number;
  modelSelected(modelId: string, provider: string): void;
  error(error?: unknown, errorType?: string): void;
  cost(cost: ScopeCost): void;
  readonly mcp: McpLifecycle;
}
import type { ActionKind } from "#tracing/core/types.js";
import type { ChannelMetadata, PrincipalMetadata } from "#tracing/core/contract.js";

export interface TurnMetadata {
  readonly sequence: number;
  readonly subagent?: boolean;
  readonly subagentName?: string;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly channel?: ChannelMetadata;
  readonly audience?: string;
  readonly title?: string;
  readonly scheduleId?: string;
  readonly currentPrincipal?: PrincipalMetadata;
  readonly initiatorPrincipal?: PrincipalMetadata;
  readonly delivery?: {
    readonly id: string;
    readonly input?: unknown;
    readonly channelName: string;
    readonly requestId?: string;
  };
}

export interface StepOptions {
  readonly index: number;
  readonly attempt?: number;
  readonly channel?: ChannelMetadata;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

export interface ModelOptions {
  readonly provider: string;
  readonly modelId: string;
  readonly messages?: readonly unknown[];
  readonly instructions?: unknown;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

export interface ActionOptions {
  readonly callId: string;
  readonly name: string;
  readonly kind?: ActionKind;
  readonly arguments?: unknown;
}

export interface ApprovalOptions {
  readonly requestId: string;
  readonly request?: unknown;
}

export interface MemoryOptions {
  readonly operation: "search_memory" | "upsert_memory";
  readonly phase: string;
  readonly slot: string;
  readonly storeId: string;
}

export interface TraceCheckpointer {
  load(key: string): Promise<ScopeRecord | undefined>;
  save(record: ScopeRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface MemoryResult<T> {
  readonly value: T;
  readonly recordCount?: number;
  readonly records?: readonly { id?: string; content: string }[];
}

export interface ScopeCost {
  readonly cost?: number;
  readonly gatewayCost?: number;
  readonly inputCost?: number;
  readonly outputCost?: number;
  readonly generationId?: string;
}

export interface RuntimeBinding {
  readonly key: string;
  readonly reference?: TraceReference;
  readonly startTimeMs?: number;
  readonly links?: readonly TraceLink[];
  readonly deferred?: boolean;
  readonly parent?: TraceReference;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  readonly executionContext?: ExecutionContext;
  readonly outputContext?: Readonly<Record<string, string>>;
}

export interface ScopeTerminal {
  readonly outcome?: string;
  readonly failed?: boolean;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly output?: unknown;
  readonly response?: unknown;
  readonly usage?: Usage;
  readonly model?: ModelResult;
  readonly recordCount?: number;
  readonly records?: readonly { id?: string; content: string }[];
  readonly endTimeMs?: number;
}
