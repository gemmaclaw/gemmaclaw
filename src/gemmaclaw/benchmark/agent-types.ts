/**
 * Leaf type definitions shared by agent-runner.ts and agent-validator.ts.
 * Lives in its own module so the runner can depend on the validator and the
 * validator can depend on shared types without forming an import cycle.
 */

import type { AgentBenchmarkTask } from "./agent-tasks.js";

export type ConversationTurn = {
  role: "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system";
  content: string;
  /** Tool name if role is tool_call. */
  toolName?: string;
  /** Tool arguments if role is tool_call. */
  toolArgs?: Record<string, unknown>;
  /** Timestamp of this turn. */
  timestamp?: string;
};

/**
 * Subset of an AgentTaskResult that the validator inspects. Defined here so
 * agent-validator.ts does not need to import the full AgentTaskResult (which
 * itself references ValidationResult and would otherwise form a cycle).
 */
export type ValidatableTaskResult = {
  task: AgentBenchmarkTask;
  conversation: ConversationTurn[];
  completionStatus: "completed" | "timeout" | "error";
  toolCallCount?: number;
  toolsUsed?: string[];
  elapsedMs?: number;
  error?: string;
};
