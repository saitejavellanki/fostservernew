FROM node:lts-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
# Copy package files first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy app source
COPY . .

# Create a non-root user if it doesn't exist and give permissions
RUN adduser -D nodeuser && \
    chown -R nodeuser:nodeuser /app

# Switch to non-root user
USER nodeuser

# Expose the correct port (5052)
EXPOSE 5058

# Start the server
CMD ["node", "server.js"]