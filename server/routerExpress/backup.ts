import express from 'express';
import busboy from 'busboy';
import { getTokenFromRequest } from '../lib/helper';
import { importBackupArchive, ImportMode } from '../lib/backup';

const router = express.Router();

router.post('/import', async (req, res) => {
  try {
    req.setTimeout(0);
    res.setTimeout(0);

    const token = await getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Content type must be multipart/form-data' });
    }

    const bb = busboy({ headers: req.headers });
    const chunks: Uint8Array[] = [];
    let mode: ImportMode = 'workspace';
    let filename = '';

    bb.on('field', (fieldname, value) => {
      if (fieldname === 'mode' && (value === 'workspace' || value === 'full')) {
        mode = value;
      }
    });

    bb.on('file', (fieldname, stream, info) => {
      if (fieldname !== 'file') {
        stream.resume();
        return;
      }

      filename = info.filename || '';
      stream.on('data', (chunk: Buffer | Uint8Array) => {
        const bytes = Buffer.isBuffer(chunk)
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : new Uint8Array(chunk);
        chunks.push(bytes);
      });
    });

    bb.on('finish', async () => {
      try {
        if (!chunks.length) {
          return res.status(400).json({ error: 'No backup file received' });
        }
        if (filename && !filename.toLowerCase().endsWith('.zip')) {
          return res.status(400).json({ error: 'Backup file must be a .zip archive' });
        }

        const result = await importBackupArchive({
          accountId: Number(token.id),
          mode,
          archiveBuffer: Buffer.concat(chunks),
        });
        return res.status(200).json(result);
      } catch (error) {
        console.error('Backup import failed:', error);
        return res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    req.pipe(bb);
  } catch (error) {
    console.error('Backup import error:', error);
    return res.status(500).json({ error: 'Import failed' });
  }
});

export default router;
