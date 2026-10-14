FROM node:20-bookworm-slim

# gcc + glibc headers + make; util-linux provides prlimit (resource limits).
# Add any extra C libraries you want students to be able to #include / link here,
# e.g. libgmp-dev libncurses-dev libssl-dev
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential util-linux \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# Hidden test cases live in problems.json. Only root (the server) may read it;
# student programs run as the unprivileged "nobody" user and cannot open it.
RUN chmod 600 /app/problems.json && chmod 644 /app/server.js

ENV PORT=3000
EXPOSE 3000

# The server starts as root only so it can chown scratch dirs and drop each
# compile/run to uid 65534. Run the container with the flags in README.md.
CMD ["node", "server.js"]
