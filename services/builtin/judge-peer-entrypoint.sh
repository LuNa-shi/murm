#!/bin/sh
set -eu
: "${SWARMENV_SERVICE_DATABASE:?Judge requires its own durable database}"
mkdir -p "$(dirname "$SWARMENV_SERVICE_DATABASE")"
export SWARMENV_JUDGE_PEER_LOCKED=true
# One process owns this store/generation. No timeout is permission to replace
# a live instance; an operator must terminate it before starting another.
exec flock --nonblock --no-fork "$SWARMENV_SERVICE_DATABASE.instance-lock" node scripts/judge-service-peer.mjs
