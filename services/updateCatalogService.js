const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function resolveBaseDirectory() {
  if (process.env.UPDATE_STORAGE_DIR) {
    return path.resolve(process.env.UPDATE_STORAGE_DIR);
  }

  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'updates');
  }

  return path.join(process.cwd(), 'updates');
}

const baseDirectory = resolveBaseDirectory();
const packagesDirectory = path.join(baseDirectory, 'packages');
const manifestPath = path.join(baseDirectory, 'version.json');

function ensureStorage() {
  fs.mkdirSync(packagesDirectory, { recursive: true });
}

function sanitizeFileName(fileName) {
  return String(fileName || 'setup.exe')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'setup.exe';
}

function normalizeVersion(version) {
  return String(version || '').trim();
}

function readManifest() {
  ensureStorage();

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read update manifest:', error.message);
    return null;
  }
}

function createDownloadUrl(req, fileName) {
  return `${req.protocol}://${req.get('host')}/updates/download/${encodeURIComponent(fileName)}`;
}

function buildPublicManifest(req, manifest) {
  if (!manifest) {
    return null;
  }

  return {
    version: manifest.version,
    downloadUrl: createDownloadUrl(req, manifest.fileName),
    releaseNotes: manifest.releaseNotes || '',
    mandatory: manifest.mandatory === true,
    publishedAt: manifest.publishedAt,
    fileName: manifest.fileName,
    fileSize: manifest.fileSize,
    sha256: manifest.sha256,
  };
}

function getPublishedManifest(req) {
  return buildPublicManifest(req, readManifest());
}

function saveUploadedRelease({ req, version, originalFileName, buffer, releaseNotes, mandatory, uploadedBy }) {
  ensureStorage();

  const normalizedVersion = normalizeVersion(version);
  if (!normalizedVersion) {
    throw new Error('Version is required');
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Installer payload is required');
  }

  const ext = path.extname(originalFileName || '').trim() || '.exe';
  const safeFileName = sanitizeFileName(`pos-setup-${normalizedVersion}${ext}`);
  const absoluteFilePath = path.join(packagesDirectory, safeFileName);

  fs.writeFileSync(absoluteFilePath, buffer);

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const manifest = {
    version: normalizedVersion,
    fileName: safeFileName,
    originalFileName: originalFileName || safeFileName,
    releaseNotes: String(releaseNotes || '').trim(),
    mandatory: mandatory === true,
    publishedAt: new Date().toISOString(),
    fileSize: buffer.length,
    sha256,
    uploadedBy: uploadedBy || null,
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    manifest,
    absoluteFilePath,
    publicManifest: buildPublicManifest(req, manifest),
  };
}

function resolveDownloadFile(fileName) {
  ensureStorage();

  const safeRequested = sanitizeFileName(fileName);
  const absolutePath = path.join(packagesDirectory, safeRequested);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  return absolutePath;
}

module.exports = {
  ensureStorage,
  getPublishedManifest,
  readManifest,
  resolveDownloadFile,
  saveUploadedRelease,
};
