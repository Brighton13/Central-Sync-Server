module.exports = (sequelize, DataTypes) => {
  const reconCreditNote = sequelize.define('reconCreditNote', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    identity_key: { type: DataTypes.STRING(180), allowNull: false },
    sync_event_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'sync_events', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    credit_note_id: { type: DataTypes.STRING(100), allowNull: false },
    receipt_number: { type: DataTypes.STRING(50), allowNull: true },
    original_sale_id: { type: DataTypes.STRING(100), allowNull: true },
    store_id: { type: DataTypes.INTEGER, allowNull: false },
    branch_id: { type: DataTypes.STRING(100), allowNull: true },
    terminal_id: { type: DataTypes.STRING(100), allowNull: true },
    credit_note_date: { type: DataTypes.DATE, allowNull: false },
    subtotal: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    tax_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    total_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    payment_method: { type: DataTypes.STRING(100), allowNull: true },
    reason: { type: DataTypes.STRING(500), allowNull: true },
    customer_name: { type: DataTypes.STRING(255), allowNull: true },
    posted_to_sage: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sage_document_number: { type: DataTypes.STRING(100), allowNull: true },
    sage_reference: { type: DataTypes.STRING(255), allowNull: true },
    exported_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'recon_credit_notes',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'uidx_recon_credit_notes_identity', unique: true, fields: ['identity_key'] },
      { name: 'idx_recon_credit_notes_date_id', fields: ['credit_note_date', 'id'] },
      { name: 'idx_recon_credit_notes_branch_date', fields: ['branch_id', 'credit_note_date', 'id'] },
      { name: 'idx_recon_credit_notes_terminal_date', fields: ['terminal_id', 'credit_note_date', 'id'] },
      { name: 'idx_recon_credit_notes_event', fields: ['sync_event_id'] },
      { name: 'idx_recon_credit_notes_posted_date', fields: ['posted_to_sage', 'credit_note_date'] },
    ],
  });

  reconCreditNote.associate = (models) => {
    reconCreditNote.belongsTo(models.syncEvent, { foreignKey: 'sync_event_id', as: 'syncEvent' });
  };

  return reconCreditNote;
};
