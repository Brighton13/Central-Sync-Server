const express = require('express');

const { reconAuth, requireReconRole } = require('../middleware/reconAuth');
const { buildActorFromReconUser, logReconRequestAudit } = require('../services/reconAuditLogService');
const {
  ensureStorage,
  getPublishedManifest,
  readManifest,
  resolveDownloadFile,
  saveUploadedRelease,
} = require('../services/updateCatalogService');

const router = express.Router();
const uploadBodyParser = express.raw({ type: 'application/octet-stream', limit: '2048mb' });

router.get('/version.json', (req, res) => {
  ensureStorage();
  const manifest = getPublishedManifest(req);

  if (!manifest) {
    return res.status(404).json({ message: 'No published update is available' });
  }

  return res.json(manifest);
});

router.get('/download/:fileName', (req, res) => {
  ensureStorage();
  const manifest = readManifest();
  if (!manifest) {
    return res.status(404).json({ message: 'No published update is available' });
  }

  if (req.params.fileName !== manifest.fileName) {
    return res.status(404).json({ message: 'Update file not found' });
  }

  const filePath = resolveDownloadFile(req.params.fileName);
  if (!filePath) {
    return res.status(404).json({ message: 'Update file not found' });
  }

  return res.download(filePath, manifest.originalFileName || manifest.fileName);
});

router.post('/admin/upload', reconAuth, requireReconRole('admin'), uploadBodyParser, async (req, res) => {
  const models = req.app.locals.models;
  const version = String(req.headers['x-update-version'] || '').trim();
  const originalFileName = String(req.headers['x-file-name'] || 'setup.exe').trim();
  const releaseNotes = String(req.headers['x-release-notes'] || '').trim();
  const mandatory = String(req.headers['x-update-mandatory'] || 'false').toLowerCase() === 'true';

  if (!version) {
    await logReconRequestAudit(models, req, {
      action: 'update.publish',
      outcome: 'failure',
      entityType: 'update',
      ...buildActorFromReconUser(req.reconUser),
      details: { reason: 'x-update-version header is required' },
    });
    return res.status(400).json({ message: 'x-update-version header is required' });
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    await logReconRequestAudit(models, req, {
      action: 'update.publish',
      outcome: 'failure',
      entityType: 'update',
      ...buildActorFromReconUser(req.reconUser),
      target_identifier: version,
      details: { reason: 'Installer payload is required' },
    });
    return res.status(400).json({ message: 'Installer payload is required' });
  }

  try {
    const { publicManifest } = saveUploadedRelease({
      req,
      version,
      originalFileName,
      buffer: req.body,
      releaseNotes,
      mandatory,
      uploadedBy: req.reconUser?.email || null,
    });

    await logReconRequestAudit(models, req, {
      action: 'update.publish',
      outcome: 'success',
      entityType: 'update',
      ...buildActorFromReconUser(req.reconUser),
      target_identifier: version,
      target_name: originalFileName,
      details: {
        mandatory,
        fileSize: req.body.length,
        fileName: publicManifest.fileName,
      },
    });

    return res.status(201).json({ success: true, update: publicManifest });
  } catch (error) {
    await logReconRequestAudit(models, req, {
      action: 'update.publish',
      outcome: 'failure',
      entityType: 'update',
      ...buildActorFromReconUser(req.reconUser),
      target_identifier: version || null,
      target_name: originalFileName || null,
      details: { reason: error.message },
    });

    return res.status(500).json({ message: error.message || 'Failed to publish update' });
  }
});

module.exports = router;
