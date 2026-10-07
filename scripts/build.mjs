import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'esm', target: ['es2022'], outfile: 'dist/app.js', legalComments: 'eof' });
const threeLicense = await readFile('node_modules/three/LICENSE', 'utf8');
const fflateLicense = await readFile('node_modules/fflate/LICENSE', 'utf8');
await writeFile('THIRD_PARTY_LICENSES.txt', `Three.js\n${threeLicense}\n\nfflate\n${fflateLicense}`);
// New HTML requests the matching CSS/JS even if a browser cached an older build.
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 10);
let html = await readFile('index.html', 'utf8');
html = html.replace(/\.\/styles\.css(?:\?v=[^"\s]*)?/, `./styles.css?v=${hash(await readFile('styles.css'))}`);
html = html.replace(/\.\/dist\/app\.js(?:\?v=[^"\s]*)?/, `./dist/app.js?v=${hash(await readFile('dist/app.js'))}`);
await writeFile('index.html', html);
console.log('Built static GitHub Pages files: dist/app.js.');
