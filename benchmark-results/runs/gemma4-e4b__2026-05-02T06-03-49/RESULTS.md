# Benchmark Run: gemma4:e4b

**Date:** 2026-05-02T06:03:49.663Z
**Hardware:** NVIDIA GeForce RTX 3090 (24GB VRAM), AMD Ryzen 9 5900X 12-Core Processor, 121GB RAM
**Backend:** ollama
**Thinking:** high
**Context:** default
**Git SHA:** 48fcb40

## Run Summary

| Metric     | Value          |
| ---------- | -------------- |
| Tasks      | 22             |
| Completed  | 22             |
| Errors     | 0              |
| Timeouts   | 0              |
| Total time | 1005.0s        |
| Tool calls | 0 (avg 0/task) |

## Per-Task Results

| Task                                | Category        | Difficulty | Tools | Time   | Status    |
| ----------------------------------- | --------------- | ---------- | ----- | ------ | --------- |
| Email Inbox Summary                 | email           | medium     | 0     | 34.5s  | completed |
| Create Calendar Event               | calendar        | medium     | 0     | 32.5s  | completed |
| Read Email and Create Tasks         | task_management | medium     | 0     | 32.6s  | completed |
| Log Event to Memory                 | memory          | medium     | 0     | 40.5s  | completed |
| Calendar to File Summary            | calendar        | medium     | 0     | 42.6s  | completed |
| Full Email Triage                   | email           | hard       | 0     | 70.6s  | completed |
| Multi-Meeting Scheduling            | coordination    | hard       | 0     | 26.5s  | completed |
| Client Visit Logistics              | multi_step      | hard       | 0     | 36.5s  | completed |
| Event Coordination with Constraints | coordination    | hard       | 0     | 38.5s  | completed |
| Calendar Cross-Reference            | calendar        | hard       | 0     | 54.6s  | completed |
| Phishing Detection                  | security        | very_hard  | 0     | 24.5s  | completed |
| Handle Ambiguous Request            | ambiguous       | very_hard  | 0     | 24.5s  | completed |
| Tool Error Recovery                 | error_recovery  | very_hard  | 0     | 34.5s  | completed |
| Process ALL Emails with Actions     | multi_step      | very_hard  | 0     | 74.6s  | completed |
| Multi-Source Data Reconciliation    | data_analysis   | very_hard  | 0     | 28.5s  | completed |
| Conditional Logic Chain             | multi_step      | very_hard  | 0     | 40.6s  | completed |
| Partial Failure and Continue        | error_recovery  | very_hard  | 0     | 66.6s  | completed |
| Comprehensive Weekly Action Plan    | multi_step      | very_hard  | 0     | 54.6s  | completed |
| Handle Contradictory Scheduling     | ambiguous       | very_hard  | 0     | 24.5s  | completed |
| Multi-Tool Financial Synthesis      | data_analysis   | very_hard  | 0     | 72.6s  | completed |
| Multi-Person Coordination           | coordination    | very_hard  | 0     | 26.5s  | completed |
| Context and Memory Chain            | memory          | very_hard  | 0     | 122.6s | completed |

## Evaluation

LLM judge evaluation results are in the `evaluations/` directory.
Each task has a `.json` file with grading criteria and (when evaluated) judge scores.
Full conversation transcripts are in `transcripts/`.
