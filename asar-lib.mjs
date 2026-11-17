import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const BLOCK_SIZE = 4 * 1024 * 1024;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function computeIntegrity(buf) {
  const blocks = [];
  for (let off = 0; off < buf.length; off += BLOCK_SIZE) {
    blocks.push(sha256(buf.subarray(off, Math.min(off + BLOCK_SIZE, buf.length))));
  }
  if (blocks.length === 0) {
    blocks.push(sha256(buf));
  }
  return {
    algorithm: 'SHA256',
    hash: sha256(buf),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

/**
 * Parses an ASAR archive into its JSON header and packed file buffers.
 */
export function readAsar(asarPath) {
  const buf = readFileSync(asarPath);
  const picklePayloadSize = buf.readUInt32LE(4);
  const dataOffset = 8 + picklePayloadSize;
  const headerLen = buf.readUInt32LE(12);
  const headerJson = buf.subarray(16, 16 + headerLen).toString('utf8');
  const header = JSON.parse(headerJson);

  const files = new Map();
  function walk(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(entry, rel);
      } else if (!entry.unpacked) {
        const off = dataOffset + Number(entry.offset);
        files.set(rel, {
          entry,
          data: buf.subarray(off, off + entry.size),
        });
      }
    }
  }
  walk(header);
  return { header, files };
}

/**
 * Writes an ASAR archive back to disk, updating offsets and SHA-256 integrity.
 */
export function writeAsar(outPath, header, files) {
  let cursor = 0;
  const chunks = [];

  function rebuild(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        rebuild(entry, rel);
      } else if (!entry.unpacked) {
        const item = files.get(rel);
        if (!item) {
          throw new Error(`Missing file buffer for ${rel}`);
        }
        const data = item.data;
        entry.size = data.length;
        entry.offset = String(cursor);
        if (entry.integrity) {
          entry.integrity = computeIntegrity(data);
        }
        chunks.push(data);
        cursor += data.length;
      }
    }
  }

  rebuild(header);

  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const paddedLen = Math.ceil(headerBytes.length / 4) * 4;
  const pickle = Buffer.alloc(16 + paddedLen);
  pickle.writeUInt32LE(4, 0);
  pickle.writeUInt32LE(paddedLen + 8, 4);
  pickle.writeUInt32LE(paddedLen + 4, 8);
  pickle.writeUInt32LE(headerBytes.length, 12);
  headerBytes.copy(pickle, 16);

  const outBuf = Buffer.concat([pickle, ...chunks]);
  writeFileSync(outPath, outBuf);
}
