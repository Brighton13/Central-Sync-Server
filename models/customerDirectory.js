module.exports = (sequelize, DataTypes) => {
  const customerDirectory = sequelize.define('customerDirectory', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tpin: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    legal_name: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    source_system: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'pos-backend',
    },
    lookup_source: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    last_verified_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_seen_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName: 'customer_directory',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'uidx_customer_directory_tpin', unique: true, fields: ['tpin'] },
      { name: 'idx_customer_directory_last_seen_at', fields: ['last_seen_at'] },
    ],
  });

  return customerDirectory;
};