import type {
  ActionScope,
  MemoryOptions,
  RuntimeScope,
  ScopeTerminal,
  StepScope,
  TurnScope,
} from "#tracing/lib/core/scopes.js";
import { disabledTurn } from "#tracing/lib/core/disabled.js";

const runtimes = new WeakMap<object, RuntimeScope>();

/** Callback topology is a view over lifecycle operations, not another trace engine. */
export function topologyScope(runtime: RuntimeScope): TurnScope | StepScope | ActionScope {
  async function execute<T>(
    operation: RuntimeScope,
    callback: () => Promise<T>,
    terminal?: (value: T) => ScopeTerminal,
  ): Promise<T> {
    await operation.started();
    try {
      const value = await operation.run(callback);
      let result: ScopeTerminal = {};
      try {
        result = terminal?.(value) ?? { output: value };
      } catch {}
      try {
        await operation.completed(result);
      } catch {}
      return value;
    } catch (error) {
      try {
        await operation.failed(error);
      } catch {}
      throw error;
    }
  }
  async function memory<T>(
    options: MemoryOptions,
    callback: () => Promise<T>,
    describe: (value: T) => {
      recordCount?: number;
      records?: readonly { id?: string; content: string }[];
    },
  ): Promise<T> {
    let operation;
    try {
      operation = await runtime.memory(options);
    } catch {
      return callback();
    }
    return execute(operation, callback, describe);
  }
  const memories = {
    searchMemory<T>(
      options: Omit<MemoryOptions, "operation">,
      callback: () => Promise<T>,
      describe: (value: T) => {
        recordCount?: number;
        records?: readonly { id?: string; content: string }[];
      },
    ) {
      return memory({ ...options, operation: "search_memory" }, callback, describe);
    },
    writeMemory<T>(
      options: Omit<MemoryOptions, "operation">,
      callback: () => Promise<T>,
      describe: (value: T) => {
        recordCount?: number;
        records?: readonly { id?: string; content: string }[];
      },
    ) {
      return memory({ ...options, operation: "upsert_memory" }, callback, describe);
    },
  };
  let scope: TurnScope | StepScope | ActionScope;
  switch (runtime.type) {
    case "activation":
      scope = {
        async attempt(options, callback) {
          let next;
          try {
            next = await runtime.step({ index: options.stepIndex, attempt: options.attempt });
          } catch {
            return disabledTurn().attempt(options, callback);
          }
          return execute(next, () => callback(next.authoring as StepScope));
        },
        ...memories,
      };
      break;
    case "step":
      scope = {
        async modelCall(options, callback, result) {
          let next;
          try {
            next = await runtime.model(options);
          } catch {
            return callback();
          }
          return execute(next, callback, (value) =>
            result === undefined ? {} : { model: result(value) },
          );
        },
        async action(options, callback, describe) {
          let next;
          try {
            next = await runtime.action(options);
          } catch {
            return disabledTurn().attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
              attempt.action(options, callback, describe),
            );
          }
          return execute(
            next,
            () => callback(next.authoring as ActionScope),
            (value) => {
              const result = describe(value);
              return {
                ...result,
                failed: result.outcome === "failed",
                errorCode: "errorType" in result ? result.errorType : undefined,
              };
            },
          );
        },
        ...memories,
      };
      break;
    case "action":
      scope = {
        async toolExecution(input, callback, describe) {
          let next;
          try {
            next = await runtime.tool({ key: input.executionId });
          } catch {
            return callback();
          }
          return execute(next, callback, (value) => {
            const result = describe(value);
            return {
              ...result,
              failed: result.outcome === "failed",
              errorCode: "errorType" in result ? result.errorType : undefined,
            };
          });
        },
        async approval(options, callback, outcome) {
          let next;
          try {
            next = await runtime.approval(options);
          } catch {
            return callback();
          }
          return execute(next, callback, (response) => ({
            outcome: outcome(response).outcome,
            response,
          }));
        },
        ...memories,
      };
      break;
    default:
      scope = { ...memories } as TurnScope;
  }
  runtimes.set(scope, runtime);
  return scope;
}

export function scopeRuntime(scope: TurnScope | StepScope | ActionScope): RuntimeScope {
  const runtime = runtimes.get(scope);
  if (runtime === undefined) throw new Error("The scope belongs to another tracing lifecycle.");
  return runtime;
}
