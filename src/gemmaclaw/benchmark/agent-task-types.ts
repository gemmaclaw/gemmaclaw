export type AgentGradingType = "conversation_check" | "artifact_check" | "tool_sequence_check";

export type AgentTaskCategory =
  | "email"
  | "calendar"
  | "task_management"
  | "multi_step"
  | "security"
  | "error_recovery"
  | "memory"
  | "ambiguous"
  | "data_analysis"
  | "coordination"
  | "structured_output"
  | "tool_intent"
  | `expanded_${string}`
  | `variant_${string}`;

export type AgentTaskDifficulty = "easy" | "medium" | "hard" | "very_hard";

export type DeterministicExpectedValue = string | string[];

export type AgentDeterministicGrading =
  | {
      type: "json_fields";
      requiredKeys: string[];
      expectedFields: Record<string, DeterministicExpectedValue>;
      allowExtraKeys?: boolean;
    }
  | {
      type: "tool_intent";
      allowedActions: string[];
      expectedAction: string;
      expectedArguments: Record<string, DeterministicExpectedValue>;
      allowExtraTopLevelKeys?: boolean;
      allowExtraArgumentKeys?: boolean;
    };

export type AgentDeterministicScore = {
  taskId: string;
  score: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  method: "deterministic";
  details: string;
};

export type AgentBenchmarkTask = {
  id: string;
  name: string;
  description: string;
  category: AgentTaskCategory;
  difficulty: AgentTaskDifficulty;
  /** The prompt sent to the agent. */
  prompt: string;
  grading: {
    type: AgentGradingType;
    /** What the LLM judge checks for in the full conversation. */
    criteria: string[];
    /** Deterministic scorer used for small schema/intent tasks. */
    deterministic?: AgentDeterministicGrading;
    maxScore: number;
  };
  /** Deterministic mock response used by --mock mode when present. */
  mock?: {
    finalResponse: string;
  };
  /**
   * When true, the benchmark harness skips gog tool injection for this task.
   * Use for models that reject tool-augmented API calls (e.g. Ollama models
   * that return 400 "does not support tools"). Tasks with this flag must not
   * rely on gog commands; they receive a plain text conversation only.
   */
  noToolsMode?: boolean;
};
