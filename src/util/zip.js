"use strict";
/**
 * Minimaler ZIP-Schreiber (Methode "store", ohne Kompression).
 *
 * Wird nur für den Export des Aufnahme-Datensatzes gebraucht. WAV-Dateien
 * lassen sich ohnehin kaum komprimieren, deshalb genügt "store" – und das
 * Projekt bleibt ohne zusätzliche Abhängigkeit.
 */
const zlib = require("zlib");

/** MS-DOS-Zeitformat, das in ZIP-Einträgen steckt. */
function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/**
 * Baut ein ZIP-Archiv im Speicher.
 * @param {{name: string, data: Buffer|string, date?: Date}[]} files
 * @returns {Buffer}
 */
function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const { time, day } = dosDateTime(file.date || new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signatur
    localHeader.writeUInt16LE(20, 4); // benötigte Version
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8-Dateinamen
    localHeader.writeUInt16LE(0, 8); // Methode: store
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // erzeugt von Version
    centralHeader.writeUInt16LE(20, 6); // benötigte Version
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

// Fallback für Node-Versionen ohne zlib.crc32.
let table = null;
function crc32(buffer) {
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

module.exports = { createZip };
