const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME || 'central_sync',
  process.env.DB_USER || 'sa',
  process.env.DB_PASSWORD || 'Admin123',
  {
    host: process.env.DB_HOST || 'localhost',
    dialect: process.env.DB_DIALECT || 'mysql',
    logging: false,
    pool: {
      max: Number(process.env.DB_POOL_MAX || 15),
      min: Number(process.env.DB_POOL_MIN || 2),
      acquire: Number(process.env.DB_POOL_ACQUIRE_MS || 30000),
      idle: Number(process.env.DB_POOL_IDLE_MS || 10000),
    },
  }
);

module.exports = sequelize;
