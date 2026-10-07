import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import validator from 'gltf-validator';

// Run the official Khronos validator against every converted motorcycle bundle.
const catalog = JSON.parse(await readFile('assets/catalog.json', 'utf8'));
const models = [];
for (const model of catalog.models) {
  const bytes = await readFile(model.model);
  const report = await validator.validateBytes(new Uint8Array(bytes), { uri: model.model, maxIssues: 1000 });
  models.push({ id: model.id, bytes: bytes.length, issues: report.issues, info: report.info });
  console.log(`${model.id}: ${report.issues.numErrors} errors, ${report.issues.numWarnings} warnings`);
}
await mkdir('outputs', { recursive: true });
const result = { validatorVersion: validator.version(), checkedAt: new Date().toISOString(), models };
await writeFile('outputs/gltf-validation.json', JSON.stringify(result, null, 2));
assert.ok(models.every(model => model.issues.numErrors === 0), 'Invalid glTF asset: see outputs/gltf-validation.json');
console.log(`All ${models.length} model bundles passed glTF validation.`);
