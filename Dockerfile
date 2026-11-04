FROM node:24-bookworm-slim AS landing
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
RUN npm run web:build

FROM node:24-bookworm-slim
ARG CLEO_BUILD_SHA=development
ENV CLEO_BUILD_SHA=${CLEO_BUILD_SHA}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates postgresql-15 gosu poppler-utils antiword catdoc && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY --from=landing /app/dist/landing ./dist/landing
COPY skills ./skills
COPY scripts/start.ts scripts/meeting-latency.ts ./scripts/
COPY scripts/container-entrypoint.sh scripts/container-run.sh ./scripts/
RUN chmod +x scripts/container-*.sh
ENV PATH="/usr/lib/postgresql/15/bin:${PATH}"
CMD ["/app/scripts/container-entrypoint.sh"]
