FROM node:24-slim

# curl is needed for HEALTHCHECK (node:24-slim includes it)
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy source (no build step needed, Node 24 runs .ts natively)
COPY src/ src/
COPY package.json .

# Write .build-version from package.json so orchestrator reads the same
# semver as the proxy (written by start.sh on the host).
RUN node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)" > /app/.build-version

# Data directory for SQLite — writable by any UID (container runs as host user via docker-compose user:)
RUN mkdir -p /data/.agentic-collab && chmod 777 /data/.agentic-collab

ENV PORT=3000
ENV DB_PATH=/data/.agentic-collab/orchestrator.db
ENV HOME=/data

EXPOSE 3000

# Loosened 2026-08-05 (incident: host-global OOM + transient event-loop stalls
# under full-fleet load false-killed the orchestrator via the old 5s/3-retry probe,
# turning a transient stall into a restart kill-loop). 30s timeout + 5 retries +
# 60s start-period keeps GENUINE-hang protection (a real sustained ~2.5min hang still
# restarts) while tolerating transient load. Belt-and-suspenders with the compose
# healthcheck override (both loosened). See data/knowledge/lessons + incident record.
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=5 \
  CMD curl -sf http://localhost:${PORT}/api/orchestrator/status || exit 1

CMD ["node", "src/orchestrator/main.ts"]
