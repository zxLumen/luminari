FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    LUMINARI_PORT=8790 \
    LUMINARI_HOST=0.0.0.0 \
    LUMINARI_DATA_DIR=/data
COPY web/package.json ./
COPY web/server.js ./
COPY web/lib/ ./lib/
COPY web/scripts/ ./scripts/
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
RUN mkdir -p /data
EXPOSE 8790
CMD ["node", "server.js"]
