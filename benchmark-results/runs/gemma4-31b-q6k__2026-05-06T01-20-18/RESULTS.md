# Benchmark Run: gemma4-31b-q6k

**Date:** 2026-05-06T01:20:18.838Z
**Hardware:** NVIDIA GeForce RTX 3090 (24GB VRAM), AMD Ryzen 9 5900X 12-Core Processor, 121GB RAM
**Backend:** ollama
**Thinking:** high
**Context:** default
**Git SHA:** 27fd171

## Run Summary

| Metric     | Value             |
| ---------- | ----------------- |
| Tasks      | 22                |
| Completed  | 4                 |
| Errors     | 16                |
| Timeouts   | 2                 |
| Total time | 19364.9s          |
| Tool calls | 41 (avg 1.9/task) |

## Per-Task Results

| Task                                | Category        | Difficulty | Tools | Time    | Status    |
| ----------------------------------- | --------------- | ---------- | ----- | ------- | --------- |
| Email Inbox Summary                 | email           | medium     | 0     | 248.8s  | error     |
| Create Calendar Event               | calendar        | medium     | 0     | 182.7s  | error     |
| Read Email and Create Tasks         | task_management | medium     | 0     | 208.7s  | error     |
| Log Event to Memory                 | memory          | medium     | 0     | 164.7s  | error     |
| Calendar to File Summary            | calendar        | medium     | 0     | 196.7s  | error     |
| Full Email Triage                   | email           | hard       | 0     | 210.7s  | error     |
| Multi-Meeting Scheduling            | coordination    | hard       | 0     | 256.7s  | error     |
| Client Visit Logistics              | multi_step      | hard       | 0     | 246.7s  | error     |
| Event Coordination with Constraints | coordination    | hard       | 0     | 226.7s  | error     |
| Calendar Cross-Reference            | calendar        | hard       | 0     | 236.7s  | error     |
| Phishing Detection                  | security        | very_hard  | 0     | 3606.7s | timeout   |
| Handle Ambiguous Request            | ambiguous       | very_hard  | 0     | 535.0s  | error     |
| Tool Error Recovery                 | error_recovery  | very_hard  | 0     | 3606.6s | timeout   |
| Process ALL Emails with Actions     | multi_step      | very_hard  | 13    | 2520.2s | completed |
| Multi-Source Data Reconciliation    | data_analysis   | very_hard  | 13    | 2478.8s | completed |
| Conditional Logic Chain             | multi_step      | very_hard  | 8     | 1237.5s | completed |
| Partial Failure and Continue        | error_recovery  | very_hard  | 7     | 1672.1s | completed |
| Comprehensive Weekly Action Plan    | multi_step      | very_hard  | 0     | 202.7s  | error     |
| Handle Contradictory Scheduling     | ambiguous       | very_hard  | 0     | 296.8s  | error     |
| Multi-Tool Financial Synthesis      | data_analysis   | very_hard  | 0     | 312.8s  | error     |
| Multi-Person Coordination           | coordination    | very_hard  | 0     | 242.7s  | error     |
| Context and Memory Chain            | memory          | very_hard  | 0     | 472.9s  | error     |

## Evaluation

LLM judge evaluation results are in the `evaluations/` directory.
Each task has a `.json` file with grading criteria and (when evaluated) judge scores.
Full conversation transcripts are in `transcripts/`.
