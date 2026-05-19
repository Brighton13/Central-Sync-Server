module.exports = (sequelize, DataTypes) => {
  const reconUser = sequelize.define('reconUser', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    full_name: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(160),
      allowNull: false,
      unique: true,
    },
    password_hash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('admin', 'finance'),
      allowNull: false,
      defaultValue: 'finance',
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    last_login_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName: 'recon_users',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'uidx_recon_users_email', unique: true, fields: ['email'] },
      { name: 'idx_recon_users_role', fields: ['role'] },
      { name: 'idx_recon_users_active', fields: ['active'] },
    ],
  });

  return reconUser;
};