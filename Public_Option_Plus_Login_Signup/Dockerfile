FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Account data (users, invites, settings, sessions, transfer log) lives in
# /app/data as a single JSON file. Mount a volume here so it survives
# container rebuilds — otherwise every `docker compose up --build` would
# wipe your users and settings.
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
