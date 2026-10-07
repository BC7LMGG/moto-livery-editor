import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'esm', target: ['es2022'], outfile: 'dist/app.js', legalComments: 'eof' });
const threeLicense = await readFile('node_modules/three/LICENSE', 'utf8');
const fflateLicense = await readFile('node_modules/fflate/LICENSE', 'utf8');
await writeFile('THIRD_PARTY_LICENSES.txt', `Three.js\n${threeLicense}\n\nfflate\n${fflateLicense}`);
console.log('Built static GitHub Pages files: dist/app.js.');
