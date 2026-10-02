import type { TurnScope, StepScope, ActionScope } from "#tracing/core/application.js";

export function disabledTurn(): TurnScope {
  const memory = async <T>(
    _input: unknown,
    execute: () => Promise<import("#tracing/core/scope-lifecycle.js").MemoryResult<T>>,
  ) => (await execute()).value;
  const action: ActionScope = {
    toolExecution: (_input, execute) => execute(),
    approval: (_input, execute) => execute(),
    memory,
  };
  const attempt: StepScope = {
    modelCall: (_input, execute) => execute(),
    action: (_input, execute) => execute(action),
    memory,
  };
  return { attempt: (_input, execute) => execute(attempt), memory };
}
