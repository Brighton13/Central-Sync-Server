const { Sequelize } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const db = {};
const modelDefinitions = [
  require('./customerDirectory'),
  require('./reconAuditLog'),
  require('./reconUser'),
  require('./passwordResetOtp'),
  require('./reconBatch'),
  require('./reconSale'),
  require('./reconCreditNote'),
  require('./reconProjectionState'),
  require('./syncEvent'),
  require('./syncSaleExport'),
];

modelDefinitions.forEach((defineModel) => {
  const model = defineModel(sequelize, DataTypes);
  db[model.name] = model;
});

Object.keys(db).forEach((modelName) => {
  if (typeof db[modelName].associate === 'function') {
    db[modelName].associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
