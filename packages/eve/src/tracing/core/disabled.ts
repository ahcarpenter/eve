import type { TurnScope, StepScope, ActionScope } from "#tracing/core/application.js";

export function disabledTurn(): TurnScope {
  const memory = <T>(_input: unknown, execute: () => Promise<T>) => execute();
  const action: ActionScope = {
    toolExecution: (_input, execute) => execute(),
    approval: (_input, execute) => execute(),
    searchMemory: memory,
    writeMemory: memory,
  };
  const attempt: StepScope = {
    modelCall: (_input, execute) => execute(),
    action: (_input, execute) => execute(action),
    searchMemory: memory,
    writeMemory: memory,
  };
  return {
    attempt: (_input, execute) => execute(attempt),
    searchMemory: memory,
    writeMemory: memory,
  };
}
