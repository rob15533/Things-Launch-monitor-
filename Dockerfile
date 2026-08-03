FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /app/data
ENV STATE_DIR=/app/data
CMD ["npm", "start"]