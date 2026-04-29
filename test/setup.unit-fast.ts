// Minimal env isolation for unit-fast tests.
//
// unit-fast intentionally skips installSharedTestSetup() (which calls
// withIsolatedTestHome) to keep startup fast. But many pure-function unit
// tests pass `cfg` objects without `gateway.port` and assert default
// behavior (DEFAULT_GATEWAY_PORT = 18789). When the developer's shell has
// `OPENCLAW_GATEWAY_PORT` set (e.g. for a locally running gateway on a
// non-default port), `resolveGatewayPort(cfg)` reads that env var via its
// default `process.env` argument and returns the leaked value, breaking
// these unit tests.
//
// This file clears the small set of env vars that pure-function unit tests
// assume are unset. Heavy isolation (temp HOME, profile env loading,
// channel-specific env scrubbing) stays in installSharedTestSetup for the
// unit/integration suites that need it.
const ENV_VARS_TO_CLEAR = [
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_BRIDGE_ENABLED",
  "OPENCLAW_BRIDGE_HOST",
  "OPENCLAW_BRIDGE_PORT",
  "OPENCLAW_CANVAS_HOST_PORT",
];
for (const key of ENV_VARS_TO_CLEAR) {
  delete process.env[key];
}
