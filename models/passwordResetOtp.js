module.exports = (sequelize, DataTypes) => {
  const passwordResetOtp = sequelize.define('passwordResetOtp', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    otp_hash: { type: DataTypes.STRING(64), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    consumed_at: { type: DataTypes.DATE, allowNull: true },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'password_reset_otps',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'idx_password_reset_otps_user_created', fields: ['user_id', 'created_at'] },
      { name: 'idx_password_reset_otps_expires', fields: ['expires_at'] },
    ],
  });

  passwordResetOtp.associate = (models) => {
    passwordResetOtp.belongsTo(models.reconUser, { foreignKey: 'user_id', as: 'user' });
  };

  return passwordResetOtp;
};
