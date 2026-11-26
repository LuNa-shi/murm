ARG MURM_WORKER_IMAGE=murm-programbench-base:local
FROM programbench/sharkdp_1776_pastel.b60e899@sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e AS cleanroom
FROM ${MURM_WORKER_IMAGE}
LABEL org.murm.benchmark.instance="sharkdp__pastel.b60e899" \
      org.murm.benchmark.cleanroom="sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e"
COPY --from=cleanroom --chown=0:0 --chmod=0111 /workspace/executable /opt/programbench/executable
COPY --from=cleanroom --chown=0:0 --chmod=0444 /workspace/README.md /workspace/LICENSE-APACHE /workspace/LICENSE-MIT /opt/programbench/
COPY --from=cleanroom --chown=0:0 /workspace/doc/ /opt/programbench/doc/
RUN chmod -R go-w /opt/programbench
