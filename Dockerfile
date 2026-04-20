FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3060
ENV DB_DIR=/app/data

RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 3060

CMD ["node", "server.js"]
