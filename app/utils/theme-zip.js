import zlib from "node:zlib";

// CRC32 table for fast checksum computation
const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

function calculateCrc32(buf) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Creates a valid, standard PKZIP archive buffer from a list of Shopify theme files.
 * @param {Array<{ filename?: string, key?: string, content?: string, value?: string, bodyType?: string }>} themeFiles
 * @returns {Buffer} Standard ZIP buffer ready for download or upload to Shopify Admin
 */
export function buildThemeZip(themeFiles = []) {
  const fileEntries = [];
  let offset = 0;
  const parts = [];

  for (const f of themeFiles) {
    const rawPath = f.filename || f.key || "";
    if (!rawPath) continue;

    // Normalize path (ensure no leading slash)
    const filePath = rawPath.replace(/^\/+/, "");
    const pathBuf = Buffer.from(filePath, "utf8");

    // Decode binary base64 assets vs text files
    let data;
    if (f.bodyType === "BASE64" && f.content) {
      data = Buffer.from(f.content, "base64");
    } else {
      data = Buffer.from(f.content || f.value || "", "utf8");
    }

    const compressed = zlib.deflateRawSync(data);
    const useCompressed = compressed.length < data.length;
    const body = useCompressed ? compressed : data;
    const method = useCompressed ? 8 : 0;
    const crc = calculateCrc32(data);

    // Local file header (30 bytes)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
    localHeader.writeUInt16LE(method, 8);     // Compression method
    localHeader.writeUInt16LE(0, 10);         // Last mod file time
    localHeader.writeUInt16LE(0, 12);         // Last mod file date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(body.length, 18); // Compressed size
    localHeader.writeUInt32LE(data.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(pathBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28);         // Extra field length

    parts.push(localHeader, pathBuf, body);

    fileEntries.push({
      pathBuf,
      method,
      crc,
      compSize: body.length,
      uncompSize: data.length,
      offset,
    });

    offset += localHeader.length + pathBuf.length + body.length;
  }

  const cdStartOffset = offset;
  let cdSize = 0;

  for (const entry of fileEntries) {
    // Central directory file header (46 bytes)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory header signature
    cdHeader.writeUInt16LE(20, 4);         // Version made by
    cdHeader.writeUInt16LE(20, 6);         // Version needed to extract
    cdHeader.writeUInt16LE(0, 8);          // General purpose bit flag
    cdHeader.writeUInt16LE(entry.method, 10); // Compression method
    cdHeader.writeUInt16LE(0, 12);         // Last mod file time
    cdHeader.writeUInt16LE(0, 14);         // Last mod file date
    cdHeader.writeUInt32LE(entry.crc, 16); // CRC-32
    cdHeader.writeUInt32LE(entry.compSize, 20); // Compressed size
    cdHeader.writeUInt32LE(entry.uncompSize, 24); // Uncompressed size
    cdHeader.writeUInt16LE(entry.pathBuf.length, 28); // File name length
    cdHeader.writeUInt16LE(0, 30);         // Extra field length
    cdHeader.writeUInt16LE(0, 32);         // File comment length
    cdHeader.writeUInt16LE(0, 34);         // Disk number start
    cdHeader.writeUInt16LE(0, 36);         // Internal file attributes
    cdHeader.writeUInt32LE(0, 38);         // External file attributes
    cdHeader.writeUInt32LE(entry.offset, 42); // Relative offset of local header

    parts.push(cdHeader, entry.pathBuf);
    cdSize += cdHeader.length + entry.pathBuf.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // EOCD signature
  eocd.writeUInt16LE(0, 4);                   // Number of this disk
  eocd.writeUInt16LE(0, 6);                   // Disk where central directory starts
  eocd.writeUInt16LE(fileEntries.length, 8);  // Total entries on this disk
  eocd.writeUInt16LE(fileEntries.length, 10); // Total entries
  eocd.writeUInt32LE(cdSize, 12);             // Size of central directory
  eocd.writeUInt32LE(cdStartOffset, 16);      // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                  // Comment length

  parts.push(eocd);
  return Buffer.concat(parts);
}
