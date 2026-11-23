FROM mcr.microsoft.com/playwright:v1.54.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js agent-terminal.js api-auth.js upload-security.js ./
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p data
ENV BROWSERBRO_PORT=3101
ENV BROWSERBRO_HOST=0.0.0.0
EXPOSE 3101
CMD ["node", "server.js"]
