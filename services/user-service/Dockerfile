FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts

COPY src ./src

EXPOSE 3000

CMD ["npx", "ts-node", "--transpile-only", "src/index.ts"]
