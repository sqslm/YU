# The server has zero npm dependencies: `node:sqlite`, `node:crypto` and
# `node:http` cover accounts, tokens and storage. That keeps the image small and
# means there is no install step to break.
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

RUN mkdir -p /data && chown -R node:node /data

# Runs unprivileged: the process only needs its own data directory.
USER node

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.mjs"]
