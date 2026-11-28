#!/bin/sh
set -eu
: "${MURM_SERVICE_DATABASE:?Judge requires its own durable database}"
mkdir -p "$(dirname "$MURM_SERVICE_DATABASE")"
export MURM_JUDGE_PEER_LOCKED=true
# One process owns this store/generation. No timeout is permission to replace
# a live instance; an operator must terminate it before starting another.
exec flock --nonblock --no-fork "$MURM_SERVICE_DATABASE.instance-lock" node dist/examples/taskpool/deploy/service-hosts/start-judge-service-peer.js
