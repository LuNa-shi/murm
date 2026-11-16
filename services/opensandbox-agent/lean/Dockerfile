# syntax=docker/dockerfile:1.7
ARG AGENT_IMAGE
FROM ${AGENT_IMAGE}
# Named contexts contain operator-selected, prebuilt dependencies. Copy only
# compiler files and library artifacts: never the benchmark checkout/answers.
COPY --from=lean-toolchain --chown=0:0 --chmod=0755 /bin /opt/swarmenv/lean/bin
COPY --from=lean-toolchain --chown=0:0 --chmod=0755 /lib /opt/swarmenv/lean/lib
COPY --from=lean-packages --chown=0:0 --chmod=0755 /mathlib/.lake/build/lib/lean /opt/swarmenv/lean-deps/mathlib
COPY --from=lean-packages --chown=0:0 --chmod=0755 /batteries/.lake/build/lib/lean /opt/swarmenv/lean-deps/batteries
COPY --from=lean-packages --chown=0:0 --chmod=0755 /Qq/.lake/build/lib/lean /opt/swarmenv/lean-deps/Qq
COPY --from=lean-packages --chown=0:0 --chmod=0755 /aesop/.lake/build/lib/lean /opt/swarmenv/lean-deps/aesop
COPY --from=lean-packages --chown=0:0 --chmod=0755 /proofwidgets/.lake/build/lib/lean /opt/swarmenv/lean-deps/proofwidgets
COPY --from=lean-packages --chown=0:0 --chmod=0755 /importGraph/.lake/build/lib/lean /opt/swarmenv/lean-deps/importGraph
COPY --from=lean-packages --chown=0:0 --chmod=0755 /LeanSearchClient/.lake/build/lib/lean /opt/swarmenv/lean-deps/LeanSearchClient
COPY --from=lean-packages --chown=0:0 --chmod=0755 /plausible/.lake/build/lib/lean /opt/swarmenv/lean-deps/plausible
COPY --chown=0:0 --chmod=0755 lean /usr/local/bin/lean
COPY --chown=0:0 --chmod=0444 environment.json /opt/swarmenv/lean-environment.json
RUN chmod 0555 /usr/local/bin/lean \
  && ln -s /opt/swarmenv/lean/bin/lake /usr/local/bin/lake
# Local diagnostics only. Judge independently checks fixed public revisions.
