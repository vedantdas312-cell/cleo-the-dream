import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { DocumentError, inspectDocx, MAX_FILE_BYTES, sha256 } from './docx.ts';

// Read-only local IPC. This is not a desktop identity, upload or matter link.
export async function inspectDesktopSource(path: string, expectedSha256?: string) {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.docx') {
    throw new DocumentError('Choose a local .docx file using the file picker.');
  }
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new DocumentError('Invalid source version. Select the document again.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let input: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new DocumentError('Choose a regular .docx file.');
    if (stat.size > MAX_FILE_BYTES) throw new DocumentError('Word files must be at most 10 MB.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new DocumentError('Word files must be at most 10 MB.');
    input = buffer.subarray(0, size);
  } finally { await file.close(); }
  if (expectedSha256 !== undefined && sha256(input) !== expectedSha256) {
    throw new DocumentError('The source document changed. Select it again before continuing.');
  }
  return { filename: basename(path), byteLength: input.length, ...await inspectDocx(input) };
}
