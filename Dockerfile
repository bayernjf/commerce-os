# The typed decision client is a cross-repo `file:` dependency
# (../zeus/packages/zeus-client). It is supplied to the build as a named
# context "zeusclient" so no cross-directory COPY is needed:
#   docker build --build-context zeusclient=../zeus/packages/zeus-client .
# docker-compose.yml wires this additional_context automatically.

# ---- build stage: compile TypeScript ----------------------------------
# "base" is provided as a named context (docker-image://node:22-slim) so the
# build works offline with the locally present image, without a registry
# round-trip. See docker-compose.yml additional_contexts.
FROM base AS build

WORKDIR /app

# Place the client where the package.json "file:../zeus/..." path resolves.
COPY --from=zeusclient ./ /zeus/packages/zeus-client/

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----------------------------------------------------
FROM base

WORKDIR /app

COPY --from=zeusclient ./ /zeus/packages/zeus-client/

# node:sqlite needs the experimental flag at runtime; no native deps are
# required. Postgres support requires the optional `pg` package in the
# production image (npm install pg), not installed here.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY db ./db
COPY recordings ./recordings
COPY --from=build /app/dist ./dist

ENV COMMERCE_DB_DRIVER=sqlite \
    COMMERCE_SQLITE_PATH=/data/commerce-os.db \
    COMMERCE_HOST=0.0.0.0 \
    COMMERCE_PORT=8787

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "--experimental-sqlite", "dist/serve.js"]
