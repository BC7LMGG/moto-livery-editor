import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { LoadingManager, Texture, Box3, Vector3 } from 'three';

// Read exported FBX only. No .blend project is opened or changed.
const append = process.argv.includes('--append');
const sources = process.argv.slice(2).filter(arg => arg !== '--append');
if (!sources.length) throw new Error('Usage: node scripts/import-assets.mjs [--append] "path/to/models-or-bike" [...]');
const destination = path.resolve('assets/models');
await mkdir(destination, { recursive: true });
const modelNames = { KWSKX250F: 'Kawasaki KX250F', KawasakiNinjaH2: 'Kawasaki Ninja H2', KawasakiNinjaZX10R: 'Kawasaki Ninja ZX-10R', KTM690SMCR: 'KTM 690 SMC R', BMWM1000RR: 'BMW M 1000 RR', BMWS1000R: 'BMW S 1000 R', DucatiStreetV4S: 'Ducati Streetfighter V4 S', DucatiPanigaleV4S: 'Ducati Panigale V4 S', DucatiSuperLeggera: 'Ducati Superleggera', HondaSH150: 'Honda SH150', SurronUltraBee: 'Sur-Ron Ultra Bee', SuzuLtr450: 'Suzuki LT-R450', YamaAerox: 'Yamaha Aerox', YamBanshee: 'Yamaha Banshee', YamRaptorR1: 'Yamaha Raptor', YamYfz450: 'Yamaha YFZ450' };
const partNames = { Plastic: 'Пластик', Seat: 'Сиденье', Swingarm: 'Маятник', HandlebarPad: 'Подушка руля', HeadlightMask: 'Маска фары', InnerPlastic: 'Внутренний пластик', SidePlastic: 'Боковой пластик', RearPlastic: 'Задний пластик', FrontPlastic: 'Передний пластик', ForkGuards: 'Защита вилки', RearPlasticAndHandguards: 'Задний пластик и защита рук', FrontFender: 'Переднее крыло', Footboards: 'Подножки' };
const manager = new LoadingManager();
// Source material images are unnecessary. The editor supplies its own canvases.
manager.addHandler(/.*/, { path: '', setPath(value) { this.path = value; return this; }, load() { return new Texture(); } });
const loader = new FBXLoader(manager);
Object.assign(modelNames, { BSEZ3: 'BSE Z3', KayoK1: 'Kayo K1', Progassi300: 'Progassi 300', KewsK16: 'Kews K16' });
partNames.SwingarmGuards = 'Защита маятника';
const audit = append ? JSON.parse(await readFile('outputs/asset-audit.json', 'utf8').catch(() => '{"models":[],"maskOnlyParts":[]}')) : { models: [], maskOnlyParts: [] };
audit.sourceFilesUnchanged = true;
const manifest = append ? JSON.parse(await readFile('assets/catalog.json', 'utf8')).models : [];
const folders = new Map();
for (const source of sources) {
  const absolute = path.resolve(source); const name = path.basename(absolute);
  if (modelNames[name]) folders.set(name, absolute);
  else for (const folder of await readdir(absolute, { withFileTypes: true })) {
    if (folder.isDirectory() && modelNames[folder.name]) folders.set(folder.name, path.join(absolute, folder.name));
  }
}
if (!folders.size) throw new Error('No supported motorcycle folders found.');

function glb(parts) {
  const json = { asset: { version: '2.0', generator: 'Livery Studio FBX asset preparation' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [] };
  const binary = []; let offset = 0;
  function accessor(array, componentType, type, min, max, target) {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const padding = (4 - offset % 4) % 4;
    if (padding) { binary.push(Buffer.alloc(padding)); offset += padding; }
    const view = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    binary.push(bytes); offset += bytes.length;
    const index = json.accessors.length;
    json.accessors.push({ bufferView: view, componentType, count: array.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3 }[type]), type, ...(min ? { min, max } : {}) });
    return index;
  }
  for (const part of parts) {
    json.materials.push({ name: part.id, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .65 }, doubleSided: true });
    for (const mesh of part.meshes) {
      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position'); const normal = geometry.getAttribute('normal'); const uv = geometry.getAttribute('uv');
      geometry.computeBoundingBox();
      const positions = Float32Array.from({ length: position.count * 3 }, (_, i) => position.array[i]);
      const normals = Float32Array.from({ length: normal.count * 3 }, (_, i) => normal.array[i]);
      // glTF images use a top-left UV origin; FBX uses a bottom-left origin.
      const uvs = Float32Array.from({ length: uv.count * 2 }, (_, i) => i % 2 ? 1 - uv.array[i] : uv.array[i]);
      const attributes = { POSITION: accessor(positions, 5126, 'VEC3', geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray(), 34962), NORMAL: accessor(normals, 5126, 'VEC3', null, null, 34962), TEXCOORD_0: accessor(uvs, 5126, 'VEC2', null, null, 34962) };
      const primitive = { attributes, material: json.materials.length - 1 };
      if (geometry.index) primitive.indices = accessor(Uint32Array.from(geometry.index.array), 5125, 'SCALAR', null, null, 34963);
      const meshIndex = json.meshes.length;
      json.meshes.push({ name: part.id, primitives: [primitive] });
      json.scenes[0].nodes.push(json.nodes.length);
      json.nodes.push({ name: part.id, mesh: meshIndex, extras: { partId: part.id } });
    }
  }
  const bin = Buffer.concat(binary); const binPadded = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  json.buffers[0].byteLength = bin.length;
  const jsonBytes = Buffer.from(JSON.stringify(json)); const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 32)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonPadded.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binPadded.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
}

for (const [name, sourceFolder] of folders) {
  const folder = { name };
  const files = await readdir(sourceFolder);
  const meshFiles = await readdir(path.join(sourceFolder, 'Meshes'));
  if (!files.some(f => f.endsWith('_MASK.png'))) throw new Error(`No MASK PNGs: ${name}`);
  audit.models = audit.models.filter(m => m.id !== name);
  audit.maskOnlyParts = audit.maskOnlyParts.filter(p => p.model !== name);
  const parts = []; const converted = []; const bounds = new Box3(); let triangles = 0;
  const target = path.join(destination, folder.name); await mkdir(target, { recursive: true });
  for (const maskFile of files.filter(f => f.endsWith('_MASK.png')).sort()) {
    const stem = maskFile.replace(/_MASK\.png$/, '');
    const role = stem.replace(new RegExp(`^${folder.name}_\\d+_`), '');
    const number = stem.match(/_(\d+)_/)?.[1];
    const image = await readFile(path.join(sourceFolder, maskFile));
    const maskWidth = image.readUInt32BE(16); const maskHeight = image.readUInt32BE(20);
    const meshFile = [`${stem}_UV_V2.fbx`, `${stem}.fbx`].find(f => meshFiles.includes(f)); const hasMesh = !!meshFile;
    const part = { id: stem, name: partNames[role] || role, number, role, mask: `assets/models/${folder.name}/${maskFile}`, width: maskWidth, height: maskHeight, hasMesh, color: role === 'Seat' ? '#30343b' : role === 'Swingarm' || role === 'InnerPlastic' ? '#666e7b' : role === 'HandlebarPad' ? '#20262e' : folder.name === 'KWSKX250F' ? '#b8ed42' : '#f0f1f2' };
    parts.push(part); await copyFile(path.join(sourceFolder, maskFile), path.join(target, maskFile));
    if (!hasMesh) { audit.maskOnlyParts.push({ model: folder.name, part: stem }); continue; }
    const data = await readFile(path.join(sourceFolder, 'Meshes', meshFile));
    const object = loader.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
    object.updateMatrixWorld(true); const meshes = [];
    object.traverse(node => {
      if (!node.isMesh) return;
      const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
      if (!geometry.getAttribute('uv')) throw new Error(`Missing UV: ${meshFile}`);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      geometry.computeBoundingBox(); bounds.union(geometry.boundingBox);
      triangles += (geometry.index?.count || geometry.getAttribute('position').count) / 3;
      meshes.push({ geometry });
    });
    if (!meshes.length) throw new Error(`No mesh: ${meshFile}`);
    converted.push({ id: stem, meshes });
  }
  // Sort the principal plastic and seat first in the UI.
  const roleOrder = role => role === 'Plastic' ? 0 : role === 'Seat' ? 1 : 2;
  parts.sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.number.localeCompare(b.number));
  const counts = Object.groupBy(parts, p => p.name);
  for (const entries of Object.values(counts)) if (entries.length > 1) entries.forEach(p => { p.name += ` · ${p.number}`; });
  const buffer = glb(converted); await writeFile(path.join(target, 'model.glb'), buffer);
  const previous = manifest.findIndex(m => m.id === folder.name);
  const entry = { id: folder.name, name: modelNames[folder.name], model: `assets/models/${folder.name}/model.glb`, parts };
  if (previous >= 0) manifest[previous] = entry; else manifest.push(entry);
  audit.models.push({ id: folder.name, parts: parts.length, meshParts: converted.length, triangles, glbBytes: buffer.length, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), size: bounds.getSize(new Vector3()).toArray() } });
  console.log(`${folder.name}: ${converted.length} mesh parts, ${parts.length} masks, ${Math.round(buffer.length / 1024)} KB GLB`);
}
manifest.sort((a, b) => a.id === 'KWSKX250F' ? -1 : b.id === 'KWSKX250F' ? 1 : a.name.localeCompare(b.name));
await writeFile('assets/catalog.json', JSON.stringify({ version: 1, defaultModel: 'KWSKX250F', models: manifest }, null, 2));
await mkdir('outputs', { recursive: true }); await writeFile('outputs/asset-audit.json', JSON.stringify(audit, null, 2));
console.log(`Imported ${manifest.length} models; mask-only parts: ${audit.maskOnlyParts.length}.`);
