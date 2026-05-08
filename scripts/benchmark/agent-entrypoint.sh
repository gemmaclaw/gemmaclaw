#!/bin/bash
# Entrypoint for the gemmaclaw benchmark agent container.
# Prepends fake-gog to PATH so all gog commands return mock fixture data.
# The container has no real Google credentials (GOG_ACCESS_TOKEN is a dummy).
# Exec the passed command: node /app/gemmaclaw.mjs agent --local ...
set -e

export PATH="/app/scripts/benchmark/fake-gog:$PATH"
export GEMMACLAW_FAKE_GOG_LOG="${GEMMACLAW_FAKE_GOG_LOG:-/tmp/fake-gog.log}"

exec "$@"
