FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ENV NODE_ENV=production HOST=0.0.0.0 DB_FILE=/data/wall.sqlite CAMERAS_FILE=/config/cameras.json
WORKDIR /app
RUN mkdir /data /generated && chown node:node /data /generated
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
