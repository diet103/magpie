// A small ZIP writer for "Download everything". Files go in as they are, with no compression (photos and PDFs
// are already compressed), and one at a time, so the archive is never held in memory as a whole.
import { crc32 } from 'node:zlib';

export interface ZipFile {
  /** Path inside the archive, with forward slashes. */
  name: string;
  bytes: Uint8Array;
}

const UTF8_NAMES = 0x0800;
// The plain format counts sizes and offsets in 32 bits and files in 16. A household's data is far below both.
const MAX_BYTES = 0xffffffff;
const MAX_FILES = 0xffff;

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Streams the files as one archive. They are read from the iterable only as the reader takes them. */
export function zipStream(files: Iterable<ZipFile>, at = new Date()): ReadableStream<Uint8Array> {
  const source = files[Symbol.iterator]();
  const { time, date } = dosTime(at);
  const directory: Buffer[] = [];
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = source.next();
      if (next.done) {
        const entries = Buffer.concat(directory);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(directory.length, 8);
        end.writeUInt16LE(directory.length, 10);
        end.writeUInt32LE(entries.length, 12);
        end.writeUInt32LE(offset, 16);
        controller.enqueue(new Uint8Array(Buffer.concat([entries, end])));
        controller.close();
        return;
      }
      const name = Buffer.from(next.value.name, 'utf8');
      const bytes = next.value.bytes;
      if (directory.length >= MAX_FILES || offset + 30 + name.length + bytes.byteLength > MAX_BYTES) throw new Error('Too much to fit in one zip file.');
      const sum = crc32(bytes);
      // Shared by the header in front of the file and its line in the directory at the end.
      const facts = Buffer.alloc(26);
      facts.writeUInt16LE(20, 0); // version needed to open it
      facts.writeUInt16LE(UTF8_NAMES, 2);
      facts.writeUInt16LE(0, 4); // stored, not compressed
      facts.writeUInt16LE(time, 6);
      facts.writeUInt16LE(date, 8);
      facts.writeUInt32LE(sum, 10);
      facts.writeUInt32LE(bytes.byteLength, 14);
      facts.writeUInt32LE(bytes.byteLength, 18);
      facts.writeUInt16LE(name.length, 22);
      const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), facts, name]);
      const listed = Buffer.alloc(46);
      listed.writeUInt32LE(0x02014b50, 0);
      listed.writeUInt16LE(20, 4); // version that made it
      facts.copy(listed, 6);
      listed.writeUInt32LE(offset, 42);
      directory.push(Buffer.concat([listed, name]));
      offset += local.length + bytes.byteLength;
      controller.enqueue(new Uint8Array(local));
      controller.enqueue(bytes);
    },
  });
}
