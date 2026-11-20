#!/usr/bin/env bash
set -eu
exec node "${SWARMENV_ROOT:?}/integrations/agensh/domain.mjs" prepare
