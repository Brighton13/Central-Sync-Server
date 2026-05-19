const { Queue } = require('bullmq');
const { connectionOptions } = require('../config/redis');

const SAGE_DISPATCH_QUEUE = 'sage-dispatch';

const sageDispatchQueue = new Queue(SAGE_DISPATCH_QUEUE, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: Number(process.env.SAGE_RETRY_ATTEMPTS || 2147483647),
    removeOnComplete: 100,
    removeOnFail: false,
    backoff: {
      type: 'fixed',
      delay: Number(process.env.SAGE_RETRY_DELAY_MS || 60000),
    },
  },
});

module.exports = {
  SAGE_DISPATCH_QUEUE,
  sageDispatchQueue,
};
