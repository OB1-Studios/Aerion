import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A plain .zip writer (and a reader for tests): deflate or stored entries, UTF-8 names, no
 * zip64. Enough for a tax pack of a few hundred files, and it opens in every operating
 * system's built-in tool. Node's zlib does the compression and the checksums.
 */

export interface ZipEntry {
  /** Path inside the zip, with forward slashes. */
  name: string;
  data: Uint8Array | string;
}

/** Wall-clock time in a time zone, as the two 16-bit DOS fields a zip stores. */
function dosTime(at: Date, timeZone: string): { time: number; date: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(at)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const hour = parts.hour === 24 ? 0 : parts.hour!;
  return {
    time: (hour << 11) | (parts.minute! << 5) | Math.floor(parts.second! / 2),
    date: ((Math.max(1980, parts.year!) - 1980) << 9) | (parts.month! << 5) | parts.day!,
  };
}

export function zip(entries: ZipEntry[], at = new Date(), timeZone = "Asia/Karachi"): Buffer {
  const names = new Set<string>();
  const { time, date } = dosTime(at, timeZone);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (names.has(e.name)) throw new Error(`Two files in the zip are called ${e.name}.`);
    names.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data);
    const packed = deflateRawSync(raw);
    const deflate = packed.length < raw.length;
    const body = deflate ? packed : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by: 2.0
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42); // extra, comment, disk and attributes stay zero
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Reads a zip written by `zip` (through its central directory), checking every checksum. */
export function unzip(buf: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(buf);
  const endAt = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error("Not a zip file.");
  const count = b.readUInt16LE(endAt + 10);
  let p = b.readUInt32LE(endAt + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("The zip's directory is damaged.");
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const skip = b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    const at = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28);
    const body = b.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (crc32(data) !== crc) throw new Error(`${name} in the zip is damaged.`);
    out.set(name, data);
    p += 46 + nameLen + skip;
  }
  return out;
}
