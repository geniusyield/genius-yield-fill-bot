FROM node:20-alpine AS build

WORKDIR /app
COPY package.json yarn.lock* ./
# Use --frozen-lockfile in CI if you commit yarn.lock; this version tolerates
# fresh-clone first-builds without one.
RUN corepack enable && yarn install

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production

# Run as non-root for defense-in-depth. K8s SecurityContext can also enforce
# this — duplicating here keeps the image safe outside K8s.
RUN addgroup -S bot && adduser -S bot -G bot
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER bot
EXPOSE 9100

CMD ["node", "dist/index.js"]
