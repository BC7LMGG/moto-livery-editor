import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class Viewer {
  constructor(container, onPick) {
    this.container = container; this.onPick = onPick; this.parts = new Map(); this.dirty = true;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#11171e');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = .85;
    container.append(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(35, 1, .01, 100); this.camera.position.set(3, 1.5, 4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true; this.controls.dampingFactor = .1; this.controls.minDistance = .12; this.controls.maxDistance = 15;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    const environment = new RoomEnvironment(); const generator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTarget = generator.fromScene(environment, .04); this.scene.environment = this.environmentTarget.texture; this.scene.environmentIntensity = .6; environment.dispose(); generator.dispose();
    this.scene.add(new THREE.HemisphereLight(0xe0f3ff, 0x263023, .7));
    const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(3, 5, 4); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xaed8ff, .6); rim.position.set(-4, 3, -3); this.scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.MeshBasicMaterial({ color: 0x151e28 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -.04; this.scene.add(floor);
    this.grid = new THREE.GridHelper(7, 28, 0x384c43, 0x26343d); this.grid.material.transparent = true; this.grid.material.opacity = .18; this.scene.add(this.grid);
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.raycaster = new THREE.Raycaster(); this.down = null;
    this.renderer.domElement.addEventListener('pointerdown', event => { this.down = { x: event.clientX, y: event.clientY }; });
    this.renderer.domElement.addEventListener('pointerup', event => {
      if (!this.down || Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.raycaster.setFromCamera({ x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1 }, this.camera);
      const hit = this.raycaster.intersectObjects(this.group.children, true).find(h => h.object.visible);
      if (hit?.object.userData.partId) this.onPick(hit.object.userData.partId);
    });
    new ResizeObserver(() => this.resize()).observe(container); this.resize();
    this.renderer.setAnimationLoop(() => { this.controls.update(); if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; } });
  }
  resize() { const w = this.container.clientWidth; const h = this.container.clientHeight; if (!w || !h) return; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); if (this.parts.size) this.reset(); this.dirty = true; }
  clear() {
    for (const child of [...this.group.children]) {
      child.traverse(node => { if (node.isMesh) { node.geometry.dispose(); for (const material of [].concat(node.material)) { material.map?.dispose(); material.dispose(); } } }); this.group.remove(child);
    }
    this.parts.clear(); this.dirty = true;
  }
  async load(url, canvases, isCurrent) {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (!isCurrent()) { gltf.scene.traverse(node => { node.geometry?.dispose(); if (node.material) [].concat(node.material).forEach(m => m.dispose()); }); return false; }
    this.clear(); this.group.position.set(0, 0, 0); this.group.scale.setScalar(1);
    gltf.scene.traverse(node => {
      if (!node.isMesh) return;
      const id = node.userData.partId || node.name; node.userData.partId = id;
      const texture = new THREE.CanvasTexture(canvases.get(id)); texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      for (const material of [].concat(node.material)) material.dispose();
      node.material = new THREE.MeshStandardMaterial({ map: texture, color: 0xffffff, side: THREE.DoubleSide, roughness: .53, metalness: .05 });
      node.material.name = id;
      if (!this.parts.has(id)) this.parts.set(id, []); this.parts.get(id).push(node);
    });
    this.group.add(gltf.scene); this.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.group); const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
    const scale = 2.5 / Math.max(size.x, size.y, size.z);
    this.group.scale.setScalar(scale); this.group.position.set(-center.x * scale, -box.min.y * scale + .04, -center.z * scale);
    this.group.updateMatrixWorld(true); this.reset(); this.dirty = true; return true;
  }
  update(id) { for (const mesh of this.parts.get(id) || []) mesh.material.map.needsUpdate = true; this.dirty = true; }
  select(id, isolate = false) { for (const [partId, meshes] of this.parts) for (const mesh of meshes) mesh.visible = !isolate || partId === id; this.dirty = true; }
  fit(box, direction = new THREE.Vector3(2.4, 1.1, 3.2)) {
    const center = box.getCenter(new THREE.Vector3()); direction.normalize();
    const vFov = THREE.MathUtils.degToRad(this.camera.fov); const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const right = new THREE.Vector3().crossVectors(this.camera.up, direction).normalize();
    if (right.lengthSq() < .001) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    let distance = .3;
    // Fit the actual projected box; a bounding sphere wastes space on small screens.
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const corner = new THREE.Vector3(x, y, z).sub(center);
      distance = Math.max(distance, corner.dot(direction) + Math.max(Math.abs(corner.dot(right)) / Math.tan(hFov / 2), Math.abs(corner.dot(up)) / Math.tan(vFov / 2)));
    }
    this.camera.position.copy(center).add(direction.multiplyScalar(distance * 1.12)); this.controls.target.copy(center); this.controls.update(); this.dirty = true;
  }
  reset() { this.fit(new THREE.Box3().setFromObject(this.group)); }
  focus(id) { const meshes = this.parts.get(id); if (!meshes?.length) return; const box = new THREE.Box3(); meshes.forEach(mesh => box.expandByObject(mesh)); this.fit(box, this.camera.position.clone().sub(this.controls.target)); }
}
