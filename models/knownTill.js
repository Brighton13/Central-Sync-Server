module.exports = (sequelize, DataTypes) => {
  const knownTill = sequelize.define('knownTill', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    branch_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    terminal_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    terminal_name: {
      type: DataTypes.STRING(160),
      allowNull: true,
    },
    source: {
      type: DataTypes.ENUM('sync', 'manual'),
      allowNull: false,
      defaultValue: 'manual',
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    last_sync_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_sync_event_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'sync_events', key: 'id' },
    },
    last_event_type: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    created_by_user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    updated_by_user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  }, {
    tableName: 'known_tills',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'uidx_known_tills_branch_terminal', unique: true, fields: ['branch_id', 'terminal_id'] },
      { name: 'idx_known_tills_active_last_sync', fields: ['active', 'last_sync_at'] },
      { name: 'idx_known_tills_store_id', fields: ['store_id'] },
    ],
  });

  return knownTill;
};
