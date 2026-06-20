module.exports = (sequelize, DataTypes) => {
  const reconSale = sequelize.define('reconSale', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    identity_key: { type: DataTypes.STRING(180), allowNull: false },
    sync_event_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'sync_events', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    sale_id: { type: DataTypes.STRING(100), allowNull: false },
    receipt_number: { type: DataTypes.STRING(50), allowNull: true },
    store_id: { type: DataTypes.INTEGER, allowNull: false },
    branch_id: { type: DataTypes.STRING(100), allowNull: true },
    terminal_id: { type: DataTypes.STRING(100), allowNull: true },
    sale_date: { type: DataTypes.DATE, allowNull: false },
    subtotal: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    discount_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    tax_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    total_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    payment_method: { type: DataTypes.STRING(100), allowNull: true },
    invoice_number: { type: DataTypes.STRING(100), allowNull: true },
    customer_name: { type: DataTypes.STRING(255), allowNull: true },
    cashier_name: { type: DataTypes.STRING(255), allowNull: true },
    posted_to_sage: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sage_document_number: { type: DataTypes.STRING(100), allowNull: true },
    sage_reference: { type: DataTypes.STRING(255), allowNull: true },
    exported_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'recon_sales',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'uidx_recon_sales_identity', unique: true, fields: ['identity_key'] },
      { name: 'idx_recon_sales_date_id', fields: ['sale_date', 'id'] },
      { name: 'idx_recon_sales_branch_date', fields: ['branch_id', 'sale_date', 'id'] },
      { name: 'idx_recon_sales_terminal_date', fields: ['terminal_id', 'sale_date', 'id'] },
      { name: 'idx_recon_sales_event', fields: ['sync_event_id'] },
      { name: 'idx_recon_sales_posted_date', fields: ['posted_to_sage', 'sale_date'] },
    ],
  });

  reconSale.associate = (models) => {
    reconSale.belongsTo(models.syncEvent, { foreignKey: 'sync_event_id', as: 'syncEvent' });
  };

  return reconSale;
};
