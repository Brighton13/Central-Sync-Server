module.exports = (sequelize, DataTypes) => sequelize.define('reconProjectionState', {
  projection_name: { type: DataTypes.STRING(100), primaryKey: true },
  last_event_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  is_backfilled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'recon_projection_state',
  timestamps: true,
  underscored: true,
});
