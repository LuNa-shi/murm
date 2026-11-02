# Loogle-compatible upstream

The optional upstream is queried at `/json?q=<query>` and may be filtered
locally by Lean module name. When the upstream is unavailable, the service can
fall back to a bounded index of the locked local source tree.

Upstream responses are normalized to `{ name, type, module, source, score }`.
Unknown fields are ignored. A malformed upstream response is a provider error,
not a mathematical result.

Declarations returned by the upstream must still be checked against the locked
project. The upstream is a discovery aid, not the Judge.
