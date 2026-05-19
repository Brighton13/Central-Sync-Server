module.exports = (sequelize, DataTypes) => {
  const reconAuditLog = sequelize.define('reconAuditLog', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    action: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    entity_type: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'user',
    },
    outcome: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'success',
    },
    actor_user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    actor_identifier: {
      type: DataTypes.STRING(160),
      allowNull: true,
    },
    actor_name: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    actor_role: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    target_user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    target_identifier: {
      type: DataTypes.STRING(160),
      allowNull: true,
    },
    target_name: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    ip_address: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    user_agent: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    details: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    occurred_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'recon_audit_logs',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'idx_recon_audit_logs_action', fields: ['action'] },
      { name: 'idx_recon_audit_logs_outcome', fields: ['outcome'] },
      { name: 'idx_recon_audit_logs_actor_user_id', fields: ['actor_user_id'] },
      { name: 'idx_recon_audit_logs_target_user_id', fields: ['target_user_id'] },
      { name: 'idx_recon_audit_logs_occurred_at', fields: ['occurred_at'] },
    ],
  });

  return reconAuditLog;
};