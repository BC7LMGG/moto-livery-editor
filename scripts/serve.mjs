import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('.'); const port = Number(process.env.PORT || 8794);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
createServer(async (request, response) => {
  try {
    let name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name.startsWith('/moto-livery-editor/')) name = name.slice('/moto-livery-editor'.length);
    let file = path.resolve(root, `.${name}`);
    if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(await readFile(file));
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Livery Studio: http://127.0.0.1:${port}/moto-livery-editor/`));
