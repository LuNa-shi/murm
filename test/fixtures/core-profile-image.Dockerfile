ARG CORE_BASE_IMAGE
FROM ${CORE_BASE_IMAGE}
ARG CORE_PROFILE_MARKER
RUN printf '%s\n' "${CORE_PROFILE_MARKER}" > /opt/swarmenv/core-profile-marker
