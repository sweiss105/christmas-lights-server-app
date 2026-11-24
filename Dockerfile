FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY tsconfig*.json ./
COPY packages packages
COPY config/example.json config/
# The web UI is built into packages/web/dist, which the server serves at /.
RUN npm run build -w @xmas/web
ENV NODE_ENV=production PORT=8080 XMAS_CONFIG=/data/show.json
EXPOSE 8080
CMD ["npm", "start"]
