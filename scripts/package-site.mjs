import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';

// Package deployment files only; exclude dependencies, source FBX and test output.
const files = {};
async function add(name) {
  const entries = await readdir(name, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.posix.join(name, entry.name);
    if (entry.isDirectory()) await add(file);
    else if (entry.isFile()) files[file] = new Uint8Array(await readFile(file));
  }
}
for (const name of ['index.html', 'styles.css', '.nojekyll', 'THIRD_PARTY_LICENSES.txt']) files[name] = new Uint8Array(await readFile(name));
await add('dist'); await add('assets');
await mkdir('outputs', { recursive: true });
const archive = zipSync(files, { level: 1 });
await writeFile('outputs/moto-livery-editor-site.zip', archive);
console.log(`Ready: outputs/moto-livery-editor-site.zip (${Object.keys(files).length} files, ${(archive.length / 1024 / 1024).toFixed(2)} MiB).`);
