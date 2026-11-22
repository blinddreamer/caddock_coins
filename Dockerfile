# Use lightweight Node image
FROM node:22-alpine

# Pull Alpine security fixes not yet in the base image
RUN apk upgrade --no-cache

# Create app directory
WORKDIR /app

# Copy package files first (better caching)
COPY package.json yarn.lock ./

# Install deps
# npm/yarn are only needed to install; drop them, their bundled deps carry CVEs
RUN yarn install --frozen-lockfile --production && yarn cache clean \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Copy rest of the app
COPY . .

# Start the bot
CMD ["node", "index.js"]