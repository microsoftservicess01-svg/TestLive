FROM node:18-bullseye-slim
WORKDIR /app
# Install build deps required by tfjs-node native bindings
RUN apt-get update && apt-get install -y python3 build-essential libpng-dev && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --progress=false
COPY . .
EXPOSE 3000
CMD [ "node", "server.js" ]
