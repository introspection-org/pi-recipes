# Serve a recipe as a standalone Tasks API service.
# Requirements: writable filesystem, outbound HTTPS to model providers and
# any bound MCP endpoints, unbuffered response streaming.
FROM node:24-slim
WORKDIR /recipe
COPY . .
# Provider credentials come from the environment at run time (e.g.
# ANTHROPIC_API_KEY); set RECIPES_SERVE_TOKEN to require a bearer.
RUN npm install --omit=dev @introspection-ai/pi-recipes
EXPOSE 8888
CMD ["npx", "recipes", "serve", ".", "--host", "0.0.0.0", "--port", "8888"]
