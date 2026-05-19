require('dotenv').config();

const { app } = require('./app');
const models = require('./models');
const { createSageWorker } = require('./workers/sageWorker');
const { sageDispatchQueue } = require('./queues/syncQueues');
const { recoverIncompleteEvents } = require('./services/syncEventQueueService');
const { ensureDefaultReconUsers } = require('./services/reconAuthService');

const PORT = Number(process.env.PORT || 4000);

app.locals.models = models;

let sageWorker;

async function ensureSyncSaleExportsSchema() {
  const queryInterface = models.sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const hasSyncSaleExports = tables
    .map((tableName) => (typeof tableName === 'object' ? Object.values(tableName)[0] : tableName))
    .includes('sync_sale_exports');

  if (!hasSyncSaleExports) {
    return;
  }

  const table = await queryInterface.describeTable('sync_sale_exports');
  const indexes = await queryInterface.showIndex('sync_sale_exports');
  const indexNames = new Set(indexes.map((index) => index.name));

  if (!table.document_type) {
    await queryInterface.addColumn('sync_sale_exports', 'document_type', {
      type: models.Sequelize.STRING(50),
      allowNull: false,
      defaultValue: 'oe_order',
    });
  }

  if (!table.sage_document_number) {
    await queryInterface.addColumn('sync_sale_exports', 'sage_document_number', {
      type: models.Sequelize.STRING(100),
      allowNull: true,
    });
  }

  if (!table.sage_document_uniquifier) {
    await queryInterface.addColumn('sync_sale_exports', 'sage_document_uniquifier', {
      type: models.Sequelize.STRING(100),
      allowNull: true,
    });
  }

  if (!table.sage_reference) {
    await queryInterface.addColumn('sync_sale_exports', 'sage_reference', {
      type: models.Sequelize.STRING(255),
      allowNull: true,
    });
  }

  if (table.sage_order_number) {
    await models.sequelize.query(`
      UPDATE sync_sale_exports
      SET sage_document_number = COALESCE(sage_document_number, sage_order_number)
      WHERE sage_order_number IS NOT NULL
    `);

    await queryInterface.changeColumn('sync_sale_exports', 'sage_order_number', {
      type: models.Sequelize.STRING(100),
      allowNull: true,
      defaultValue: null,
    });
  }

  if (table.sage_order_uniquifier) {
    await models.sequelize.query(`
      UPDATE sync_sale_exports
      SET sage_document_uniquifier = COALESCE(sage_document_uniquifier, sage_order_uniquifier)
      WHERE sage_order_uniquifier IS NOT NULL
    `);

    await queryInterface.changeColumn('sync_sale_exports', 'sage_order_uniquifier', {
      type: models.Sequelize.STRING(100),
      allowNull: true,
      defaultValue: null,
    });
  }

  if (indexNames.has('uidx_sync_sale_exports_store_sale')) {
    await queryInterface.removeIndex('sync_sale_exports', 'uidx_sync_sale_exports_store_sale');
  }
}

async function start() {
  await models.sequelize.authenticate();
  await ensureSyncSaleExportsSchema();
  await models.sequelize.sync();
  await ensureDefaultReconUsers(models);

  sageWorker = createSageWorker(models);
  sageWorker.on('completed', (job) => {
    console.log(`Sage worker completed job ${job.id}`);
  });
  sageWorker.on('failed', (job, error) => {
    console.error(`Sage worker failed job ${job?.id}:`, error.message);
  });

  const recoveredCount = await recoverIncompleteEvents(models);
  if (recoveredCount > 0) {
    console.log(`Recovered ${recoveredCount} incomplete sync event(s) back into the queue`);
  }

  app.listen(PORT, () => {
    console.log(`Central sync server running on port ${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down central sync server...`);

  try {
    if (sageWorker) {
      await sageWorker.close();
    }
    await sageDispatchQueue.close();
    await models.sequelize.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('Shutdown error:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('Shutdown error:', error);
    process.exit(1);
  });
});

start().catch((error) => {
  console.error('Failed to start central sync server:', error);
  process.exit(1);
});
