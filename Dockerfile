# ---- deps: full deps for building ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
# --legacy-peer-deps: repo's class-validator version conflicts with
# @nestjs/mapped-types's peer range; the existing lockfile only resolves
# with this flag (matches how node_modules was actually installed locally).
RUN npm ci --legacy-peer-deps

# ---- build: compile TypeScript -> dist ----
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- prod-deps: production-only node_modules ----
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg: merges Higgsfield scene chunks into one final video (creative.controller.ts's
# higgsfield-scenes/merge route). @higgsfield/cli: the only way this backend talks to
# Higgsfield (no public REST API) — both the single-shot and scene-chunk video paths
# shell out to it. NOTE: the CLI still needs ~/.config/higgsfield/credentials.json +
# config.json present at runtime (minted once via `higgsfield auth login` on a machine
# with a browser — see higgsfield.service.ts's class comment) — that's a deploy-time
# secret-provisioning step, not something this Dockerfile can do.
RUN apk add --no-cache ffmpeg && npm install -g @higgsfield/cli
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER nestjs
EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('net').connect(process.env.APP_PORT||8082,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

CMD ["node", "dist/main"]
