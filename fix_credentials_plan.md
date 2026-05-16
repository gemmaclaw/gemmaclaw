# Plan: Fix Vertex AI Automated Credential Resolution

## Task Overview

Fix HTTP 401 Unauthorized error when `useAutomatedCredentials` is set in `gemmaclaw`. The system should resolve a fresh token using `gcloud auth application-default print-access-token`.

## Subtasks

- [x] Research: Find `gcp-vertex-credentials` and `useAutomatedCredentials` in the codebase. <!-- id: 0 -->
- [x] Analyze: Determine if the logic is active in 'embedded' or 'cli' paths. <!-- id: 1 -->
- [x] Implement Fix: Fix any regressions or missing wiring. <!-- id: 2 -->
- [x] Verification: Run a test script/command to verify the resolution logic. <!-- id: 3 -->

## Progress Notes

- Updated `src/infra/gemini-auth.ts` to support the marker.
- Added `GCP_VERTEX_CREDENTIALS_MARKER` to `CORE_NON_SECRET_API_KEY_MARKERS` in `src/agents/model-auth-markers.ts`.
- Verified with unit tests and `tsx` script.
- Rebuilt the project.
