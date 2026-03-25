# Use lightweight Node image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files first (better caching)
COPY package.json yarn.lock ./

# Install deps
RUN yarn install --production

# Copy rest of the app
COPY . .

# Start the bot
CMD ["node", "index.js"]