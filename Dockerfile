# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install build dependencies for native modules (like tree-sitter)
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci && \
    apk del .build-deps

# Copy the rest of the application
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install runtime dependencies (like git for repository caching), build dependencies, install production dependencies, and clean up build tools
RUN apk add --no-cache git && \
    apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev && \
    apk del .build-deps

# Generate Prisma client for production
RUN npx prisma generate

# Copy built artifacts from the builder stage
COPY --from=builder /app/dist ./dist

# Set environment variable defaults
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

# Expose the server port
EXPOSE 3001

# Start the application
CMD ["node", "dist/server.js"]
