import type {
  ExecutionContext,
  TraceReference,
  TraceLink,
  Usage,
} from "#tracing/lib/core/types.js";
import type { ModelResult } from "#tracing/lib/core/scopes.js";
import type { CaptureDecision } from "#tracing/lib/core/types.js";
import type { McpLifecycle } from "#tracing/lib/core/mcp.js";
import type { RunIdentity, FrameworkIdentity } from "#tracing/lib/core/types.js";

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

/** Detached state persisted by the runtime with its workflow checkpoint. */
export interface ScopeRecord {
  readonly version?: 1;
  readonly key: string;
  readonly identity: ScopeIdentity;
  readonly data: ScopeData;
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly attempt?: { readonly index: number; readonly attempt: number };
  readonly capture: CaptureDecision;
  readonly startTimeMs: number;
  readonly links?: readonly TraceLink[];
  readonly outputContext?: Readonly<Record<string, string>>;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
}

export interface RuntimeScope {
  readonly type: ScopeData["type"];
  readonly reference: TraceReference;
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  model(options: ModelOptions, binding: RuntimeBinding): Promise<RuntimeScope>;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  finish(result?: ScopeTerminal): Promise<void>;
  started(): Promise<void>;
  usage(usage: Usage, callKey?: string): Promise<void>;
  modelSelected(modelId: string, provider: string): void;
  error(error?: unknown, errorType?: string): void;
  cost(cost: ScopeCost): void;
  readonly mcp: McpLifecycle;
}
import type { ActionKind } from "#tracing/lib/core/types.js";
import type { ChannelMetadata, PrincipalMetadata } from "#tracing/lib/core/contract.js";

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
