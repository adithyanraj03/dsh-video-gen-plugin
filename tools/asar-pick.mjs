// Minimal asar reader: parse header, list or extract files.
// usage: node asar-pick.mjs <asar> list [substr]
//        node asar-pick.mjs <asar> get <relpath> <outdir>
import fs from 'node:fs';
import path from 'node:path';

const [asar, mode, a, b] = process.argv.slice(2);
const buf = fs.readFileSync(asar);
const headerSize = buf.readUInt32LE(12); // bytes 8..12 = json len
const jsonLen = headerSize;
const json = buf.toString('utf8', 16, 16 + jsonLen);
const header = JSON.parse(json);
const dataStart = 16 + Math.ceil(jsonLen / 4) * 4;

function walk(node, prefix = '') {
  const out = [];
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) out.push(...walk(child, p));
    else if (child.size != null) out.push({ p, offset: dataStart + Number(child.offset), size: Number(child.size) });
  }
  return out;
}

const files = walk(header);
if (mode === 'list') {
  const needle = a ?? '';
  for (const f of files) if (f.p.toLowerCase().includes(needle.toLowerCase())) console.log(`${f.size}\t${f.p}\t${f.offset}`);
  if (!needle) console.error(`total files: ${files.length}`, { stderr: true });
} else if (mode === 'get') {
  const f = files.find((x) => x.p === a);
  if (!f) {
    console.error(`not found: ${a}`);
    process.exit(1);
  }
  const chunk = buf.subarray(f.offset, f.offset + f.size);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.writeFileSync(b, chunk);
  console.log(`wrote ${b} (${f.size} bytes)`);
}
