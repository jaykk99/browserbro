FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p data
ENV BROWSERBRO_PORT=3101
EXPOSE 3101
CMD ["node", "server.js"]
