import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync } from 'node:fs';
import { request } from 'node:https';
import { BlockList } from 'node:net';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(process.env.STUDIO_DATA_DIR || '.studio-data');
mkdirSync(root, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(resolve(root, 'archive.sqlite'));
db.exec(`
  PRAGMA auto_vacuum = INCREMENTAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS tasks (
    owner TEXT NOT NULL, record TEXT NOT NULL, provider TEXT, prompt TEXT NOT NULL,
    settings TEXT NOT NULL, status TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
    PRIMARY KEY (owner, record)
  );
  CREATE INDEX IF NOT EXISTS task_history ON tasks(owner, created DESC);
  CREATE TABLE IF NOT EXISTS images (
    owner TEXT NOT NULL, record TEXT NOT NULL, position INTEGER NOT NULL,
    mime TEXT NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY (owner, record, position),
    FOREIGN KEY (owner, record) REFERENCES tasks(owner, record) ON DELETE CASCADE
  );
`);

export function ownerFor(key) {
  return createHash('sha256').update(key).digest('hex');
}

const findTask = db.prepare('SELECT * FROM tasks WHERE owner = ? AND record = ?');
const insertTask = db.prepare('INSERT OR IGNORE INTO tasks (owner, record, provider, prompt, settings, status, created) VALUES (?, ?, ?, ?, ?, ?, ?)');
const updateTask = db.prepare('UPDATE tasks SET provider = coalesce(?, provider), status = ?, sources = ?, error = ? WHERE owner = ? AND record = ?');
const imagePositions = db.prepare('SELECT position FROM images WHERE owner = ? AND record = ? ORDER BY position');
const archiveJobs = new Set();
const retryAfter = new Map();
const maxImage = 16 * 1024 * 1024;
const maxStorage = 8 * 1024 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix);

function imageMime(bytes) {
  const hex = bytes.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return 'image/gif';
  if (hex.startsWith('52494646') && hex.endsWith('57454250')) return 'image/webp';
  if (['ftypavif', 'ftypavis'].includes(bytes.toString('ascii', 4, 12))) return 'image/avif';
  throw new Error('Unrecognized image format');
}

async function downloadImage(value, signal, redirects = 0) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || redirects > 3) {
    throw new Error('Unsupported image URL');
  }
  const { address } = await lookup(url.hostname, { family: 4 });
  if (blocked.check(address)) throw new Error('Non-public image destination');
  return new Promise((resolveDownload, reject) => {
    const req = request(url, {
      family: 4, signal, autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { Accept: 'image/*' },
    }, async (response) => {
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.destroy();
          return resolveDownload(await downloadImage(new URL(response.headers.location, url), signal, redirects + 1));
        }
        if (response.statusCode !== 200 || Number(response.headers['content-length']) > maxImage) {
          response.destroy();
          throw new Error('Image unavailable or oversized');
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > maxImage) throw new Error('Image oversized');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        resolveDownload({ mime: imageMime(bytes), bytes });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end();
  });
}

function enqueue(owner, row) {
  const job = owner + row.record;
  if (archiveJobs.has(job) || archiveJobs.size >= 3 || (retryAfter.get(job) || 0) > Date.now()) return;
  const urls = JSON.parse(row.sources);
  if (!urls.length) return;
  archiveJobs.add(job);
  void (async () => {
    try {
      for (const [position, url] of urls.entries()) {
        if (!findTask.get(owner, row.record)) return;
        if (db.prepare('SELECT 1 FROM images WHERE owner=? AND record=? AND position=?').get(owner, row.record, position)) continue;
        const image = await downloadImage(url, AbortSignal.timeout(12000));
        if (!findTask.get(owner, row.record)) return;
        const size = db.prepare('SELECT (page_count - freelist_count) * page_size AS bytes FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()').get().bytes;
        if (size + image.bytes.length > maxStorage) throw new Error('Image storage is full');
        db.prepare('INSERT OR IGNORE INTO images VALUES (?, ?, ?, ?, ?)').run(owner, row.record, position, image.mime, image.bytes);
      }
      db.prepare("UPDATE tasks SET sources='[]' WHERE owner=? AND record=?").run(owner, row.record);
      retryAfter.delete(job);
    } catch {
      const until = Date.now() + 60_000;
      retryAfter.set(job, until);
      setTimeout(() => { if (retryAfter.get(job) === until) retryAfter.delete(job); }, 60_000).unref();
    } finally {
      archiveJobs.delete(job);
    }
  })();
}

export function readRecord(owner, record) {
  const row = findTask.get(owner, record);
  if (!row) return null;
  const positions = new Set(imagePositions.all(owner, record).map((image) => image.position));
  const sources = JSON.parse(row.sources);
  const savedImage = (position) => 'history-image/' + record + '/' + position;
  const images = sources.length
    ? sources.map((url, position) => positions.has(position) ? savedImage(position) : url)
    : [...positions].map(savedImage);
  if (row.status === 'succeeded' && sources.length) enqueue(owner, row);
  return { record, id: row.provider, prompt: row.prompt, settings: row.settings, status: row.status,
    images, saving: Boolean(sources.length), error: row.error };
}

setInterval(() => {
  const rows = db.prepare("SELECT * FROM tasks WHERE status='succeeded' AND sources<>'[]' ORDER BY created DESC LIMIT 120").all();
  for (const row of rows) enqueue(row.owner, row);
}, 20_000).unref();

export function history(owner, before, record) {
  const rows = db.prepare('SELECT record, created FROM tasks WHERE owner=? AND (created, record)<(?, ?) ORDER BY created DESC, record DESC LIMIT 61').all(owner, before, record);
  const page = rows.slice(0, 60);
  return { tasks: page.map(({ record }) => readRecord(owner, record)), next: rows.length > 60 ? page.at(-1) : null };
}

export function createRecord(owner, record, provider, prompt, settings) {
  insertTask.run(owner, record, provider, prompt, settings, 'pending', Date.now());
}

export function saveRecord(owner, record, { id = null, status, images = [], error = '' }) {
  const row = findTask.get(owner, record);
  if (!row || row.status === 'succeeded') return;
  updateTask.run(id, status, JSON.stringify(images), error, owner, record);
  if (status === 'succeeded') enqueue(owner, findTask.get(owner, record));
}

export function deleteRecords(owner, records) {
  db.exec('BEGIN');
  try {
    const remove = db.prepare('DELETE FROM tasks WHERE owner=? AND record=?');
    for (const record of records) remove.run(owner, record);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA incremental_vacuum(128)');
}

export function readImage(owner, record, position) {
  return db.prepare('SELECT mime, bytes FROM images WHERE owner=? AND record=? AND position=?').get(owner, record, position);
}
