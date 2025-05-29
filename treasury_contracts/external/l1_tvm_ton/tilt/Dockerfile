# Use the same base image as the hardhat node for consistency
FROM node:22-alpine AS l1-deployer-image

# install shell json parser
RUN --no-cache apk add jq

WORKDIR /usr/src/app

# create log file and give rights on it to everyone
RUN mkdir -p /usr/src/app/logs && \
    touch /usr/src/app/logs/test.log && \
    chmod 777 /usr/src/app/logs && \
    chmod 777 /usr/src/app/logs/test.log

COPY package*.json .

RUN npm install

COPY . .

# inside container service uses file named `.env`
RUN mv tilt/.env.tilt .env

# Keep the container running
CMD ["sleep", "infinity"]
