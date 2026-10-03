# Ảnh chạy Wayground Console (Node.js). Chiến lược "docker pause" cần docker CLI
# nên ảnh cài thêm gói docker-cli (nhẹ, chỉ là client).
FROM node:22-alpine

# docker CLI để đóng băng container neko (STRATEGY_DOCKER=true)
RUN apk add --no-cache docker-cli

WORKDIR /app

# Cài dependency trước để tận dụng cache layer
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY .env.example ./.env.example

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
