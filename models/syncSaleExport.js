module.exports = (sequelize, DataTypes) => {
  const syncSaleExport = sequelize.define('syncSaleExport', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    sync_event_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'sync_events',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    sale_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    receipt_number: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    document_type: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    day_end_idempotency_key: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    sage_document_number: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    sage_document_uniquifier: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    sage_reference: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    exported_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'sync_sale_exports',
    timestamps: true,
    underscored: true,
    indexes: [
      // Receipt numbers (e.g. RCP8212-1277) are prefixed with the store number and are
      // globally unique across every client POS backend, whereas store_id + sale_id are
      // local and collide across branches. The receipt is therefore the real export key.
      { name: 'uidx_sync_sale_exports_receipt_doc', unique: true, fields: ['receipt_number', 'document_type'] },
      { name: 'idx_sync_sale_exports_store_sale_doc', fields: ['store_id', 'sale_id', 'document_type'] },
      { name: 'idx_sync_sale_exports_sync_event_id', fields: ['sync_event_id'] },
      { name: 'idx_sync_sale_exports_day_end_key', fields: ['day_end_idempotency_key'] },
      { name: 'idx_sync_sale_exports_sage_document_number', fields: ['sage_document_number'] },
    ],
  });

  syncSaleExport.associate = function associate(models) {
    syncSaleExport.belongsTo(models.syncEvent, {
      foreignKey: 'sync_event_id',
      as: 'syncEvent',
    });
  };

  return syncSaleExport;
};