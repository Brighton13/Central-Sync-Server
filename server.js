require('dotenv').config();

const { app } = require('./app');
const models = require('./models');
const { createSageWorker } = require('./workers/sageWorker');
const { sageDispatchQueue } = require('./queues/syncQueues');
const { recoverIncompleteEvents } = require('./services/syncEventQueueService');
const { ensureDefaultReconUsers } = require('./services/reconAuthService');
const { backfillReconciliationProjection } = require('./services/reconciliationProjectionService');

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

  // Re-key exports on the globally-unique receipt number instead of the local
  // (store_id, sale_id) pair, which collides across client POS backends/branches.
  if (indexNames.has('uidx_sync_sale_exports_store_sale_doc')) {
    await queryInterface.removeIndex('sync_sale_exports', 'uidx_sync_sale_exports_store_sale_doc');
  }

  if (!indexNames.has('idx_sync_sale_exports_store_sale_doc')) {
    await queryInterface.addIndex('sync_sale_exports', ['store_id', 'sale_id', 'document_type'], {
      name: 'idx_sync_sale_exports_store_sale_doc',
    });
  }

  if (!indexNames.has('uidx_sync_sale_exports_receipt_doc')) {
    // Drop any pre-existing duplicate (receipt_number, document_type) rows, keeping the
    // earliest, so the new unique index can be created safely. NULL receipts are ignored.
    await models.sequelize.query(`
      DELETE t1 FROM sync_sale_exports t1
      INNER JOIN sync_sale_exports t2
        ON t1.receipt_number = t2.receipt_number
       AND t1.document_type = t2.document_type
       AND t1.receipt_number IS NOT NULL
       AND t1.id > t2.id
    `);

    await queryInterface.addIndex('sync_sale_exports', ['receipt_number', 'document_type'], {
      name: 'uidx_sync_sale_exports_receipt_doc',
      unique: true,
    });
  }
}

function normalizeTableNames(tables) {
  return new Set(tables.map((tableName) => (
    typeof tableName === 'object' ? Object.values(tableName)[0] : tableName
  )));
}

async function ensureTableColumns(queryInterface, existingTables, tableName, columnPlan) {
  if (!existingTables.has(tableName)) {
    return;
  }

  const table = await queryInterface.describeTable(tableName);
  for (const [columnName, definition] of Object.entries(columnPlan)) {
    if (table[columnName]) {
      continue;
    }

    await queryInterface.addColumn(tableName, columnName, definition);
    console.log(`Created column ${tableName}.${columnName}`);
  }
}

// Repair additive projection columns before sync attempts to create their indexes.
// This also makes startup recover safely after a previously interrupted table creation.
async function ensureReconciliationProjectionSchema() {
  const queryInterface = models.sequelize.getQueryInterface();
  const existingTables = normalizeTableNames(await queryInterface.showAllTables());
  const postingColumns = {
    posted_to_sage: {
      type: models.Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    sage_document_number: {
      type: models.Sequelize.STRING(100),
      allowNull: true,
    },
    sage_reference: {
      type: models.Sequelize.STRING(255),
      allowNull: true,
    },
    exported_at: {
      type: models.Sequelize.DATE,
      allowNull: true,
    },
  };

  await ensureTableColumns(queryInterface, existingTables, 'recon_sales', postingColumns);
  await ensureTableColumns(queryInterface, existingTables, 'recon_credit_notes', postingColumns);
  await ensureTableColumns(queryInterface, existingTables, 'recon_projection_state', {
    is_backfilled: {
      type: models.Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  });
}

// Ensure indexes exist on frequently-sorted columns. Tables like `sync_events` and
// `recon_audit_logs` carry large JSON/TEXT columns (payload, response_payload,
// last_error, details). Without an index on the ORDER BY column, MySQL filesorts the
// matching rows and buffers those blobs, overflowing sort_buffer_size at scale
// (ER_OUT_OF_SORTMEMORY). Idempotent: only adds an index when missing.
async function ensureReconIndexes() {
  const queryInterface = models.sequelize.getQueryInterface();

  const indexPlan = [
    ['sync_events', ['event_type', 'received_at', 'id'], 'idx_sync_events_type_received_id'],
    ['sync_events', ['status', 'received_at', 'id'], 'idx_sync_events_status_received_id'],
    ['sync_events', ['status'], 'idx_sync_events_status'],
    ['sync_sale_exports', ['document_type', 'exported_at', 'id'], 'idx_sync_sale_exports_type_exported_id'],
    ['recon_audit_logs', ['occurred_at'], 'idx_recon_audit_logs_occurred_at'],
  ];

  for (const [table, fields, name] of indexPlan) {
    try {
      const existing = await queryInterface.showIndex(table);
      if (existing.some((index) => index.name === name)) {
        continue;
      }
      await queryInterface.addIndex(table, fields, { name });
      console.log(`Created index ${name} on ${table}(${fields.join(', ')})`);
    } catch (error) {
      console.warn(`Skipped index ${name} on ${table}: ${error.message}`);
    }
  }
}

async function start() {
  await models.sequelize.authenticate();
  await ensureSyncSaleExportsSchema();
  await ensureReconciliationProjectionSchema();
  await models.sequelize.sync();
  await ensureReconIndexes();
  await ensureDefaultReconUsers(models);

  sageWorker = createSageWorker(models);
  sageWorker.on('active', (job) => {
    console.log(`Sage worker active job ${job.id} for syncEventId=${job.data?.syncEventId}`);
  });
  sageWorker.on('completed', (job) => {
    console.log(`Sage worker completed job ${job.id}`);
  });
  sageWorker.on('failed', (job, error) => {
    console.error(`Sage worker failed job ${job?.id}:`, error.message);
  });
  sageWorker.on('error', (error) => {
    console.error('[sageWorker] worker-level error:', error?.message || error);
  });

  const recoveredCount = await recoverIncompleteEvents(models);
  if (recoveredCount > 0) {
    console.log(`Recovered ${recoveredCount} incomplete sync event(s) back into the queue`);
  }

  app.listen(PORT, () => {
    console.log(`Central sync server running on port ${PORT}`);
  });

  backfillReconciliationProjection(models)
    .then((result) => console.log('[reconProjection] backfill complete', result))
    .catch((error) => console.error('[reconProjection] backfill failed:', error));
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
