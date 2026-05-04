# Benchmark Run: gemma4:e4b

**Date:** 2026-05-02T12:39:36.503Z
**Hardware:** NVIDIA GeForce RTX 3090 (24GB VRAM), AMD Ryzen 9 5900X 12-Core Processor, 121GB RAM
**Backend:** ollama
**Thinking:** high
**Context:** default
**Git SHA:** e41db27

## Run Summary

| Metric     | Value             |
| ---------- | ----------------- |
| Tasks      | 22                |
| Completed  | 22                |
| Errors     | 0                 |
| Timeouts   | 0                 |
| Total time | 880.8s            |
| Tool calls | 41 (avg 1.9/task) |

## Per-Task Results

| Task                                | Category        | Difficulty | Tools | Time  | Status    |
| ----------------------------------- | --------------- | ---------- | ----- | ----- | --------- |
| Email Inbox Summary                 | email           | medium     | 2     | 40.6s | completed |
| Create Calendar Event               | calendar        | medium     | 4     | 44.5s | completed |
| Read Email and Create Tasks         | task_management | medium     | 0     | 24.5s | completed |
| Log Event to Memory                 | memory          | medium     | 1     | 26.5s | completed |
| Calendar to File Summary            | calendar        | medium     | 1     | 48.6s | completed |
| Full Email Triage                   | email           | hard       | 3     | 46.6s | completed |
| Multi-Meeting Scheduling            | coordination    | hard       | 1     | 28.5s | completed |
| Client Visit Logistics              | multi_step      | hard       | 0     | 24.5s | completed |
| Event Coordination with Constraints | coordination    | hard       | 0     | 26.5s | completed |
| Calendar Cross-Reference            | calendar        | hard       | 4     | 56.6s | completed |
| Phishing Detection                  | security        | very_hard  | 0     | 24.5s | completed |
| Handle Ambiguous Request            | ambiguous       | very_hard  | 1     | 26.5s | completed |
| Tool Error Recovery                 | error_recovery  | very_hard  | 1     | 32.5s | completed |
| Process ALL Emails with Actions     | multi_step      | very_hard  | 3     | 66.6s | completed |
| Multi-Source Data Reconciliation    | data_analysis   | very_hard  | 1     | 36.5s | completed |
| Conditional Logic Chain             | multi_step      | very_hard  | 0     | 26.5s | completed |
| Partial Failure and Continue        | error_recovery  | very_hard  | 4     | 44.5s | completed |
| Comprehensive Weekly Action Plan    | multi_step      | very_hard  | 3     | 56.6s | completed |
| Handle Contradictory Scheduling     | ambiguous       | very_hard  | 0     | 20.5s | completed |
| Multi-Tool Financial Synthesis      | data_analysis   | very_hard  | 4     | 66.6s | completed |
| Multi-Person Coordination           | coordination    | very_hard  | 1     | 30.5s | completed |
| Context and Memory Chain            | memory          | very_hard  | 7     | 80.6s | completed |

## Evaluation

LLM judge evaluation results are in the `evaluations/` directory.
Each task has a `.json` file with grading criteria and (when evaluated) judge scores.
Full conversation transcripts are in `transcripts/`.
