module.exports = (sequelize, DataTypes) => {
  const syncEvent = sequelize.define('syncEvent', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    event_type: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    aggregate_type: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    aggregate_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    receipt_number: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    idempotency_key: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('received', 'queued', 'processing', 'completed', 'failed', 'dead_letter'),
      allowNull: false,
      defaultValue: 'received',
    },
    queue_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    queue_job_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    retry_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    last_error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    response_payload: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    source_system: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: 'pos-backend',
    },
    received_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    queued_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_attempt_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    processed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName: 'sync_events',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'uidx_sync_events_idempotency_key', unique: true, fields: ['idempotency_key'] },
      { name: 'idx_sync_events_status', fields: ['status'] },
      { name: 'idx_sync_events_event_type', fields: ['event_type'] },
      { name: 'idx_sync_events_store_id', fields: ['store_id'] },
    ]
  });

  syncEvent.associate = function associate(models) {
    syncEvent.hasMany(models.syncSaleExport, {
      foreignKey: 'sync_event_id',
      as: 'saleExports',
    });
  };

  return syncEvent;
};
