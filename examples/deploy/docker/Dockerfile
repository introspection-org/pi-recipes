# Serve a recipe as a standalone Tasks API service.
# Requirements: outbound HTTPS to model providers and any bound MCP
# endpoints, and unbuffered response streaming (the run stream is SSE).
FROM node:24-slim

# The server package installs on its own layer so editing the recipe does
# not reinstall dependencies on every build. Pin the version you deploy:
# a floating tag makes the image non-reproducible.
WORKDIR /app
ARG RECIPES_VERSION=latest
RUN npm install --omit=dev --ignore-scripts \
      "@introspection-ai/pi-recipes@${RECIPES_VERSION}"

# The recipe itself. Keep a .dockerignore beside it excluding .env, .git,
# and node_modules so credentials are never baked into the image.
WORKDIR /recipe
COPY . .

# Sessions are in-memory unless --session-dir is set. Mount a volume here
# to keep task transcripts across restarts; drop the flag for stateless
# deploys, or project sessions into your own store via the library API.
VOLUME ["/sessions"]

# Drop root: the recipe workspace and the session dir are the only paths
# the process writes, and both are owned by the unprivileged node user.
RUN mkdir -p /sessions && chown -R node:node /recipe /sessions
USER node

ENV NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH

# Provider credentials come from the environment at run time (e.g.
# ANTHROPIC_API_KEY); set RECIPES_SERVE_TOKEN to require a bearer.
EXPOSE 8888

# Readiness, not liveness: /ready turns 200 only once the boot preflight
# has resolved the recipe, checked credentials, and materialized MCP.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8888/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["recipes", "serve", ".", \
     "--host", "0.0.0.0", "--port", "8888", \
     "--session-dir", "/sessions"]
