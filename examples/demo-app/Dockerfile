# AQAOS 评测靶标镜像（T-E01-06）。
# Node 22 原生类型剥离直接运行 TS，无需构建步骤。
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

COPY data.ts server.ts openapi.json known-bugs.json ./
EXPOSE 4318

ENV PORT=4318
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD wget -qO- http://127.0.0.1:4318/health || exit 1

CMD ["node", "--experimental-strip-types", "server.ts"]
