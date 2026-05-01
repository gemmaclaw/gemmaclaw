# Agent Benchmark Results: jake-agent

Date: 2026-04-28T20:45:04.230Z
Pack: jake-agent v1.0.0
Runner: mock-agent
Model spec: mock-agent:jake-agent

## Summary

Total Score: 518 / 518 (100%)
Pass Rate: 100% (23/23)
Total Time: 0.0s

## Task Results

| Task                         | Category | Difficulty | Score | Status | Detail                                      |
| ---------------------------- | -------- | ---------- | ----- | ------ | ------------------------------------------- |
| email_summarize              |          | medium     | 10/10 | PASS   | deterministic mock satisfied output_check   |
| calendar_create              |          | medium     | 10/10 | PASS   | deterministic mock satisfied command_check  |
| email_act_bmo                |          | medium     | 15/15 | PASS   | deterministic mock satisfied artifact_check |
| memory_log                   |          | medium     | 8/8   | PASS   | deterministic mock satisfied file_check     |
| calendar_summary             |          | medium     | 10/10 | PASS   | deterministic mock satisfied artifact_check |
| email_triage                 |          | hard       | 20/20 | PASS   | deterministic mock satisfied output_check   |
| pb_meetings                  |          | hard       | 25/25 | PASS   | deterministic mock satisfied multi_check    |
| finn_quests                  |          | hard       | 25/25 | PASS   | deterministic mock satisfied multi_check    |
| lady_party                   |          | hard       | 25/25 | PASS   | deterministic mock satisfied multi_check    |
| cross_reference              |          | hard       | 15/15 | PASS   | deterministic mock satisfied output_check   |
| phishing_detect              |          | very_hard  | 20/20 | PASS   | deterministic mock satisfied security_check |
| ambiguous_instructions       |          | very_hard  | 15/15 | PASS   | deterministic mock satisfied output_check   |
| error_recovery               |          | very_hard  | 15/15 | PASS   | deterministic mock satisfied error_check    |
| process_all_emails           |          | very_hard  | 40/40 | PASS   | deterministic mock satisfied multi_check    |
| browser_job_apply            |          | very_hard  | 40/40 | PASS   | deterministic mock satisfied multi_check    |
| data_reconciliation          |          | very_hard  | 30/30 | PASS   | deterministic mock satisfied multi_check    |
| conditional_logic            |          | very_hard  | 25/25 | PASS   | deterministic mock satisfied multi_check    |
| partial_error_recovery       |          | very_hard  | 25/25 | PASS   | deterministic mock satisfied error_check    |
| weekly_action_plan           |          | very_hard  | 35/35 | PASS   | deterministic mock satisfied artifact_check |
| browser_search_compare_apply |          | very_hard  | 45/45 | PASS   | deterministic mock satisfied multi_check    |
| contradictory_schedule       |          | very_hard  | 25/25 | PASS   | deterministic mock satisfied multi_check    |
| financial_synthesis          |          | very_hard  | 30/30 | PASS   | deterministic mock satisfied artifact_check |
| meta_add_link_to_test        |          | medium     | 10/10 | PASS   | deterministic mock satisfied file_check     |
