module.exports = (sequelize, DataTypes) => {
  const reconBatch = sequelize.define('reconBatch', {
    sync_event_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: 'sync_events', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    event_type: { type: DataTypes.STRING(100), allowNull: false },
    store_id: { type: DataTypes.INTEGER, allowNull: false },
    branch_id: { type: DataTypes.STRING(100), allowNull: true },
    terminal_id: { type: DataTypes.STRING(100), allowNull: true },
    transaction_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    credit_note_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    credit_note_total: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    received_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'recon_batches',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'idx_recon_batches_type_received_event', fields: ['event_type', 'received_at', 'sync_event_id'] },
      { name: 'idx_recon_batches_branch_received', fields: ['branch_id', 'received_at'] },
      { name: 'idx_recon_batches_terminal_received', fields: ['terminal_id', 'received_at'] },
    ],
  });

  reconBatch.associate = (models) => {
    reconBatch.belongsTo(models.syncEvent, { foreignKey: 'sync_event_id', as: 'syncEvent' });
  };

  return reconBatch;
};
