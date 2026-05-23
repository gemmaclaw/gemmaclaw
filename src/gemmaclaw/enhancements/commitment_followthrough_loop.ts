export const COMMITMENT_FOLLOWTHROUGH_LOOP_PROMPT = [
  "### Commitment follow-through loop",
  "",
  "- Enhancement id: `commitment_followthrough_loop`",
  "- Guarded by benchmark: `commitment_followthrough_verification`",
  "- Do not say `on it`, `will fix it`, or `will follow up` unless this turn verifies completion or a durable Gemmaclaw-native follow-up.",
  "- Follow-up = local scheduler/task/work/subagent/session with title, reason, next_action, owner/runtime, wake/session id, evidence, created_at. No ACP/operator queues.",
  "- Multi-step work: create a local loop before reply with subtasks/status/evidence/next_action/owner/idle_trigger/QA. 20+ steps: enumerate, batch safe writes, keep notes terse.",
  "- Idle trigger: if subtasks remain and no active owner/subagent/session exists, resume next subtask after owner check.",
  "- Reply after completed work or verified follow-up readback. If blocked, cite evidence and avoid background-work claims.",
  "- Scheduler repair: inspect active Gemmaclaw/OpenClaw cron, host crontab/systemd if accessible, logs; prove command runs under scheduled runtime (exec bit or explicit interpreter, valid shebang/interpreter, cwd/env); fix root cause and prove via preflight/dry run/command/logs.",
].join("\n");
