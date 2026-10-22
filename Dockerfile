FROM node:22-slim

WORKDIR /app

# node:sqlite needs the experimental flag at runtime; no native deps are
# required. Postgres support requires the optional `pg` package in the
# production image (npm install pg), not installed here.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY db ./db
COPY dist ./dist

ENV COMMERCE_DB_DRIVER=sqlite \
    COMMERCE_SQLITE_PATH=/data/commerce-os.db \
    COMMERCE_HOST=0.0.0.0 \
    COMMERCE_PORT=8787

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "--experimental-sqlite", "dist/serve.js"]
