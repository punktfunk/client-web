// `dist-tizen/` as a `.wgt`: a zip with `config.xml` at its root, which is all a Tizen widget
// package is before it is signed. Unsigned on purpose — a set from 2023 on only installs a
// package signed for its own DUID, so each owner signs their copy (Apps2Samsung, or the CLI route
// on the install page), and CI needs no Tizen SDK to publish one.
//
// A zip writer of its own rather than a dependency: the format is a local header, the deflated
// bytes, and a central directory, and node ships the deflate.
//
//   node tools/wgt.mjs            → apps/web/punktfunk-tizen-<version>.wgt

import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist-tizen");

/** Every file under `dir`, as `[zip path, absolute path]`, the manifest first. */
function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push([relative(dir, p).split(sep).join("/"), p]);
    }
  };
  walk(dir);
  out.sort(([a], [b]) => (a === "config.xml" ? -1 : b === "config.xml" ? 1 : a < b ? -1 : 1));
  return out;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `entries` (`[path, bytes]`), deflated, with a fixed timestamp so a rebuild of the
 *  same files is the same archive byte for byte. */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const date = (1 << 5) | 1; // 1980-01-01 in DOS date form
  const time = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dirBytes = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...central, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = files(dist);
  const config = list.find(([p]) => p === "config.xml");
  if (!config) {
    console.error(`wgt: ${dist} has no config.xml — run \`vite build --mode tizen\` first`);
    process.exit(1);
  }
  const version = /version="([^"]+)"/.exec(readFileSync(config[1], "utf8"))?.[1] ?? "0.0.0";
  const out = join(root, `punktfunk-tizen-${version}.wgt`);
  writeFileSync(out, zip(list.map(([p, abs]) => [p, readFileSync(abs)])));
  console.log(`wgt: ${relative(process.cwd(), out)} (${list.length} files, unsigned)`);
}
