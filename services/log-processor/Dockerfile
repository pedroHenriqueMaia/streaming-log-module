FROM node:20-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts
COPY src ./src
EXPOSE 9091
CMD ["npx", "ts-node", "--transpile-only", "src/index.ts"]
