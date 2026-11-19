FROM node:22-alpine
# openssh-client + openssh-keygen：SSH 部署金鑰（連接遠端與產生金鑰）
RUN apk add --no-cache git openssh-client openssh-keygen
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
COPY scripts ./scripts
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "src/server.js"]
