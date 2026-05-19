const IORedis = require('ioredis');

const connectionOptions = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  db: Number(process.env.REDIS_DB || 0),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

if (process.env.REDIS_PASSWORD) {
  connectionOptions.password = process.env.REDIS_PASSWORD;
}

function createRedisConnection() {
  return new IORedis(connectionOptions);
}

module.exports = {
  connectionOptions,
  createRedisConnection,
};
