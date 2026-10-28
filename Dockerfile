FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=4600 NODE_ENV=production
EXPOSE 4600
USER node
CMD ["node", "server.js"]
