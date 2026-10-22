# Gemma 4 Tool Call Test

```yaml qa-scenario
id: gemma4-tool-call-test
title: Gemma 4 Tool Call Test
surface: harness
plugins:
  - openai
coverage:
  primary:
    - runtime.approvals
  secondary:
    - tools.followthrough
objective: Verify Gemma 4 tool call parsing works E2E with local proxy.
successCriteria:
  - Agent can make a tool call.
  - Suffix is stripped and output is clean.
gatewayConfigPatch:
  models:
    providers:
      openai:
        api: openai-responses
        baseUrl: http://127.0.0.1:18086/v1
        apiKey: fake-key
        models:
          - id: gemma-4-E2B-it
            name: gemma-4-E2B-it
            reasoning: true
execution:
  kind: flow
  summary: Verify Gemma 4 tool call parsing works E2E.
  config:
    preActionPrompt: Before acting, tell me the single file you would start with in six words or fewer. Do not use tools yet.
    approvalPrompt: ok do it. read `QA_KICKOFF_TASK.md` now and reply with the QA mission in one short sentence.
    expectedReplyAny:
      - qa
      - mission
      - testing
      - repo
      - worked
      - failed
      - blocked
```

```yaml qa-flow
steps:
  - name: turns short approval into a real file read
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:gemma4-tool-call-test
            message:
              expr: config.preActionPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 20000)
      - call: waitForOutboundMessage
        args:
          - ref: state
          - lambda:
               params: [candidate]
               expr: "candidate.conversation.id === 'qa-operator'"
          - expr: liveTurnTimeoutMs(env, 20000)
      - set: beforeApprovalCursor
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:gemma4-tool-call-test
            message:
              expr: config.approvalPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - set: expectedReplyAny
        value:
          expr: config.expectedReplyAny.map(normalizeLowercaseStringOrEmpty)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(beforeApprovalCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && expectedReplyAny.some((needle) => normalizeLowercaseStringOrEmpty(candidate.text).includes(needle))).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
    detailsExpr: outbound.text
```
