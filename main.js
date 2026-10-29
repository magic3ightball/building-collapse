// 건물 부수기 시제품 1
// 서 있는 동안: 블록 그래프로 하중 계산 (물리 없음)
// 무너질 때: 땅과 끊긴 덩어리 / 부러진 블록만 Rapier 강체로 넘김
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/+esm';

await RAPIER.init();

// ---------- 건물 치수 ----------
const LEVELS = 3;            // 층수
const GX = 4, GZ = 3;        // 기둥 격자 (x 4줄, z 3줄)
const SPAN = 4;              // 기둥 간격 (m)
const H = 3.2;               // 층고
const T = 0.3;               // 바닥판 두께
const CW = 0.5;              // 기둥 굵기
const GAP = 0.01;            // 충돌체끼리 딱 붙어 끼지 않게 줄이는 여유

// ---------- 하중 규칙 (단위는 임의) ----------
const W_TILE = 10, W_COL = 2;
const COL_CAP = 55;          // 기둥이 버티는 하중
const TILE_CAP = 32;         // 바닥판이 버티는 응력
const BOND_CAP = 14;         // 받침 없는 바닥판이 옆 판에 매달릴 때 이음부 한계
const HANG_FACTOR = 1.5;     // 판 가운데 걸린 점하중은 더 아프다
const IMPACT_CAP = { col: 260, tile: 140 }; // 떨어진 덩어리에 맞을 때 누적 에너지 한계
const STRUCT_DENSITY = 1.5;  // 부서진 조각의 밀도 (처음 1 → 1.5배)

// 충돌 그룹 (membership << 16 | filter): 빼낸 기둥은 잠깐 땅하고만 부딪혀서 건물 밑에서 빠져나옴
const G_ALL = (0x0001 << 16) | 0xffff, G_GROUND = (0x0002 << 16) | 0xffff, G_PULLED = (0x0008 << 16) | 0x0002;
const gx = i => (i - (GX - 1) / 2) * SPAN;
const gz = j => (j - (GZ - 1) / 2) * SPAN;

// ---------- three ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const SKY = new THREE.Color('#cfd8de');
const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 45, 110);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 300);
camera.position.set(19, 13, 22);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 8; controls.maxDistance = 70;

scene.add(new THREE.HemisphereLight('#eef3f6', '#8a8070', 1.1));
const sun = new THREE.DirectionalLight('#fff6e8', 2.2);
sun.position.set(14, 26, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 70 });
scene.add(sun);

const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({ color: '#9b9586', roughness: 1 }));
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// ---------- 색 ----------
const C_COL = new THREE.Color('#a9a49a'), C_TILE = new THREE.Color('#bdb8ad');
const C_WARN = new THREE.Color('#f0a040'), C_DANGER = new THREE.Color('#e04030');
let showStress = true;

function stressColor(base, r, out) {
  out.copy(base);
  if (!showStress) return out;
  if (r > 0.7) out.lerp(C_WARN, Math.min(1, (r - 0.7) / 0.15));
  if (r > 0.85) out.lerp(C_DANGER, Math.min(1, (r - 0.85) / 0.15));
  return out;
}

// ---------- 먼지 ----------
const DUST_N = 4000;
const dust = {
  pos: new Float32Array(DUST_N * 3), col: new Float32Array(DUST_N * 3),
  vel: new Float32Array(DUST_N * 3), life: new Float32Array(DUST_N), next: 0,
};
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dust.pos, 3));
dustGeo.setAttribute('color', new THREE.BufferAttribute(dust.col, 3));
const dustPts = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.35, vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false }));
dustPts.frustumCulled = false;
scene.add(dustPts);
for (let i = 0; i < DUST_N; i++) dust.pos[i * 3 + 1] = -100;

function puff(p, n, spread = 1) {
  for (let k = 0; k < n; k++) {
    const i = dust.next; dust.next = (dust.next + 1) % DUST_N;
    dust.pos[i * 3] = p.x + (Math.random() - 0.5) * spread;
    dust.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * spread * 0.5;
    dust.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * spread;
    const a = Math.random() * Math.PI * 2, s = 0.6 + Math.random() * 2.2;
    dust.vel[i * 3] = Math.cos(a) * s; dust.vel[i * 3 + 1] = 0.3 + Math.random() * 1.4; dust.vel[i * 3 + 2] = Math.sin(a) * s;
    dust.life[i] = 1;
  }
}
const DUST_C = new THREE.Color('#d6cfc2');
function updateDust(dt) {
  for (let i = 0; i < DUST_N; i++) {
    if (dust.life[i] <= 0) continue;
    dust.life[i] -= dt * 0.45;
    const damp = Math.exp(-dt * 1.6);
    dust.vel[i * 3] *= damp; dust.vel[i * 3 + 1] *= damp; dust.vel[i * 3 + 2] *= damp;
    dust.pos[i * 3] += dust.vel[i * 3] * dt;
    dust.pos[i * 3 + 1] += dust.vel[i * 3 + 1] * dt;
    dust.pos[i * 3 + 2] += dust.vel[i * 3 + 2] * dt;
    const l = Math.max(0, dust.life[i]);
    dust.col[i * 3] = SKY.r + (DUST_C.r - SKY.r) * l;
    dust.col[i * 3 + 1] = SKY.g + (DUST_C.g - SKY.g) * l;
    dust.col[i * 3 + 2] = SKY.b + (DUST_C.b - SKY.b) * l;
    if (l <= 0) dust.pos[i * 3 + 1] = -100;
  }
  dustGeo.attributes.position.needsUpdate = true;
  dustGeo.attributes.color.needsUpdate = true;
}

// ---------- 소리 (합성) ----------
let audio = null;
function sound(kind, strength = 1) {
  if (!audio) return;
  const t = audio.currentTime, len = kind === 'crack' ? 0.25 : kind === 'boom' ? 1.6 : 0.6;
  const buf = audio.createBuffer(1, audio.sampleRate * len, audio.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const x = i / d.length;
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, kind === 'crack' ? 6 : kind === 'boom' ? 3.5 : 2.5);
  }
  const src = audio.createBufferSource(); src.buffer = buf;
  const f = audio.createBiquadFilter();
  f.type = kind === 'crack' ? 'bandpass' : 'lowpass';
  f.frequency.value = kind === 'crack' ? 1800 : kind === 'boom' ? 160 : 260 + Math.random() * 120;
  const g = audio.createGain(); g.gain.value = Math.min(0.9, 0.25 * strength);
  src.connect(f).connect(g).connect(audio.destination);
  src.start(t);
}
addEventListener('pointerdown', () => { if (!audio) audio = new AudioContext(); }, { once: true });

// ---------- 시뮬 상태 ----------
let world, eventQueue, blocks, colAt, tileAt, bodies, colliderInfo, removed, simTime, dirty;
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpC = new THREE.Color();

function clearScene() {
  if (!bodies) return;
  for (const rec of bodies) scene.remove(rec.group);
  for (const b of blocks) if (b.mesh.parent === scene) scene.remove(b.mesh);
}

function build() {
  clearScene();
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  eventQueue = new RAPIER.EventQueue(true);
  blocks = []; bodies = []; colliderInfo = new Map(); removed = 0; simTime = 0; dirty = true;
  dust.life.fill(0);
  for (let i = 0; i < DUST_N; i++) dust.pos[i * 3 + 1] = -100;
  colAt = []; tileAt = [];

  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const gc = world.createCollider(RAPIER.ColliderDesc.cuboid(150, 0.5, 150).setFriction(0.9).setCollisionGroups(G_GROUND), g);
  colliderInfo.set(gc.handle, { ground: true });

  for (let k = 0; k < LEVELS; k++) {
    colAt[k] = []; tileAt[k] = [];
    for (let i = 0; i < GX; i++) {
      colAt[k][i] = [];
      for (let j = 0; j < GZ; j++) {
        const h = H - T;
        addBlock({ type: 'col', k, i, j, pos: new THREE.Vector3(gx(i), k * H + h / 2, gz(j)), half: new THREE.Vector3(CW / 2, h / 2, CW / 2) });
      }
    }
    for (let a = 0; a < GX - 1; a++) {
      tileAt[k][a] = [];
      for (let b = 0; b < GZ - 1; b++) {
        const x0 = gx(a) - (a === 0 ? CW / 2 : 0), x1 = gx(a + 1) + (a === GX - 2 ? CW / 2 : 0);
        const z0 = gz(b) - (b === 0 ? CW / 2 : 0), z1 = gz(b + 1) + (b === GZ - 2 ? CW / 2 : 0);
        addBlock({ type: 'tile', k, a, b, pos: new THREE.Vector3((x0 + x1) / 2, (k + 1) * H - T / 2, (z0 + z1) / 2), half: new THREE.Vector3((x1 - x0) / 2, T / 2, (z1 - z0) / 2) });
      }
    }
  }
  crane.ball = null;
  crane.anchor.set(14, ANCHOR_Y, 10); crane.target.copy(crane.anchor); crane.hits = 0;
  blast.active = false;
  document.getElementById('result').textContent = '';
  if (mode === 'wreck') spawnBall();
}

function addBlock(b) {
  b.state = 'static'; b.load = 0; b.ratio = 0; b.damage = 0; b.hang = 0; b.extra = 0;
  b.mesh = new THREE.Mesh(new THREE.BoxGeometry(b.half.x * 2, b.half.y * 2, b.half.z * 2), new THREE.MeshStandardMaterial({ color: b.type === 'col' ? C_COL : C_TILE, roughness: 0.92 }));
  b.mesh.position.copy(b.pos);
  b.mesh.castShadow = b.mesh.receiveShadow = true;
  b.mesh.userData.block = b;
  scene.add(b.mesh);
  b.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.pos.x, b.pos.y, b.pos.z));
  b.collider = world.createCollider(RAPIER.ColliderDesc.cuboid(b.half.x - GAP, b.half.y - GAP, b.half.z - GAP).setFriction(0.8).setCollisionGroups(G_ALL), b.body);
  colliderInfo.set(b.collider.handle, { block: b });
  if (b.type === 'col') colAt[b.k][b.i][b.j] = b; else tileAt[b.k][b.a][b.b] = b;
  blocks.push(b);
}

const standing = b => b && (b.state === 'static' || b.state === 'failing');
const col = (k, i, j) => (k >= 0 && k < LEVELS && i >= 0 && i < GX && j >= 0 && j < GZ) ? colAt[k][i][j] : null;
const tile = (k, a, b) => (k >= 0 && k < LEVELS && a >= 0 && a < GX - 1 && b >= 0 && b < GZ - 1) ? tileAt[k][a][b] : null;
function tilesAtPoint(k, i, j) {
  const out = [];
  for (const a of [i - 1, i]) for (const b of [j - 1, j]) { const t = tile(k, a, b); if (t) out.push(t); }
  return out;
}
const tileCorners = t => [[t.a, t.b], [t.a + 1, t.b], [t.a, t.b + 1], [t.a + 1, t.b + 1]];

function neighbors(bl) {
  const out = [];
  if (bl.type === 'col') {
    out.push(col(bl.k - 1, bl.i, bl.j), col(bl.k + 1, bl.i, bl.j));
    out.push(...tilesAtPoint(bl.k, bl.i, bl.j), ...tilesAtPoint(bl.k - 1, bl.i, bl.j));
  } else {
    for (const [i, j] of tileCorners(bl)) out.push(col(bl.k, i, j), col(bl.k + 1, i, j));
    out.push(tile(bl.k, bl.a - 1, bl.b), tile(bl.k, bl.a + 1, bl.b), tile(bl.k, bl.a, bl.b - 1), tile(bl.k, bl.a, bl.b + 1));
  }
  return out.filter(Boolean);
}

// ---------- 하중 계산: 위층부터 아래로 무게를 흘려 보냄 ----------
function computeLoads() {
  for (const b of blocks) { b.load = 0; b.ratio = 0; b.hang = 0; b.extra = 0; b.bearing = false; }
  // 아래에서 받쳐지는지 (아래층부터): 아래가 빈 기둥은 받침이 아니라 위 판에 매달린 짐
  for (let k = 0; k < LEVELS; k++) {
    for (let i = 0; i < GX; i++) for (let j = 0; j < GZ; j++) {
      const c = col(k, i, j);
      if (!standing(c)) continue;
      c.bearing = k === 0 || col(k - 1, i, j)?.bearing || tilesAtPoint(k - 1, i, j).some(t => t.bearing);
    }
    const direct = [];
    for (let a = 0; a < GX - 1; a++) for (let b = 0; b < GZ - 1; b++) {
      const t = tileAt[k][a][b];
      if (standing(t) && tileCorners(t).some(([i, j]) => col(k, i, j)?.bearing)) { t.bearing = true; direct.push(t); }
    }
    for (const t of direct) for (const n of [tile(k, t.a - 1, t.b), tile(k, t.a + 1, t.b), tile(k, t.a, t.b - 1), tile(k, t.a, t.b + 1)])
      if (standing(n)) n.bearing = true; // 한 칸까지는 외팔보로 버팀
  }
  for (let k = LEVELS - 1; k >= 0; k--) {
    // 위층 기둥의 무게: 받쳐진 기둥으로 곧장 내려가거나, 아니면 이 층 바닥판에 매달림
    for (let i = 0; i < GX; i++) for (let j = 0; j < GZ; j++) {
      const up = col(k + 1, i, j), down = col(k, i, j);
      let hangLoad = 0;
      if (standing(up)) {
        if (standing(down)) down.load += up.load; else hangLoad += up.load;
      }
      if (standing(down) && !down.bearing) { hangLoad += down.load + W_COL; down.load = 0; }
      if (!hangLoad) continue;
      const ts = tilesAtPoint(k, i, j).filter(standing);
      for (const t of ts) t.hang += hangLoad / ts.length;
    }
    const tiles = [];
    for (let a = 0; a < GX - 1; a++) for (let b = 0; b < GZ - 1; b++) if (standing(tileAt[k][a][b])) tiles.push(tileAt[k][a][b]);
    const supports = t => tileCorners(t).map(([i, j]) => col(k, i, j)).filter(c => standing(c) && c.bearing);
    // 받침 기둥이 하나도 없는 판: 옆 판에 매달림 (외팔보)
    for (const t of tiles) {
      if (supports(t).length) continue;
      const nb = [tile(k, t.a - 1, t.b), tile(k, t.a + 1, t.b), tile(k, t.a, t.b - 1), tile(k, t.a, t.b + 1)]
        .filter(n => standing(n) && supports(n).length);
      const L = W_TILE + t.hang;
      if (!nb.length) { t.ratio = 2; continue; }
      const per = L / nb.length;
      t.ratio = per * 2 / BOND_CAP;
      for (const n of nb) n.extra += per;
    }
    for (const t of tiles) {
      const s = supports(t);
      if (!s.length) continue;
      const L = W_TILE + t.hang + t.extra;
      t.load = L;
      // 받침이 한쪽 변에만 몰려 있으면 외팔보라 더 약함
      const oneSide = s.length === 2 && (s[0].i === s[1].i || s[0].j === s[1].j);
      const f = s.length === 1 ? 4 : oneSide ? 3.4 : Math.sqrt(4 / s.length);
      t.ratio = (W_TILE + HANG_FACTOR * (t.hang + t.extra)) * f / TILE_CAP;
      for (const c of s) c.load += L / s.length;
    }
    for (let i = 0; i < GX; i++) for (let j = 0; j < GZ; j++) {
      const c = col(k, i, j);
      if (!standing(c) || !c.bearing) continue;
      c.load += W_COL;
      c.ratio = c.load / COL_CAP;
    }
  }
}

function markFailures() {
  for (const b of blocks) {
    if (b.state !== 'static') continue;
    const r = Math.max(b.ratio, b.damage / IMPACT_CAP[b.type]);
    if (r > 1) startFailing(b, 0.25 + Math.random() * 0.45);
  }
}

// ---------- 넘어짐: 윗부분 무게중심이 남은 기둥들이 만드는 받침 영역 밖이면 통째로 놓아줌 ----------
const TIP_TOL = CW / 2;      // 기둥 굵기만큼은 받침으로 침
const blockVol = b => 8 * b.half.x * b.half.y * b.half.z;

function hull2(pts) { // monotone chain, [x,z] 배열
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function segDist(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / L2)) : 0;
  return Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
}
function supported(px, pz, pts) {
  const h = hull2(pts);
  if (!h.length) return false;
  if (h.length === 1) return Math.hypot(px - h[0][0], pz - h[0][1]) <= TIP_TOL;
  let inside = h.length >= 3, minD = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    if ((b[0] - a[0]) * (pz - a[1]) - (b[1] - a[1]) * (px - a[0]) < 0) inside = false;
    minD = Math.min(minD, segDist(px, pz, a, b));
  }
  return inside || minD <= TIP_TOL;
}

function checkTopple() {
  for (let k = 0; k < LEVELS; k++) {
    const above = new Set(blocks.filter(b => standing(b) && (b.type === 'tile' ? b.k >= k : b.k > k)));
    const done = new Set();
    for (const start of above) {
      if (done.has(start)) continue;
      const comp = [start]; done.add(start);
      for (let q = 0; q < comp.length; q++) for (const n of neighbors(comp[q])) if (above.has(n) && !done.has(n)) { done.add(n); comp.push(n); }
      // 이 덩어리를 받치는 k층 기둥
      const sup = new Set();
      for (const t of comp) if (t.type === 'tile' && t.k === k)
        for (const [i, j] of tileCorners(t)) { const c = col(k, i, j); if (standing(c) && c.bearing) sup.add(c); }
      if (!sup.size) continue; // 받침이 아예 없으면 연결 검사(freeDisconnected)가 처리
      let m = 0, cx = 0, cz = 0;
      for (const b of comp) { const v = blockVol(b); m += v; cx += b.pos.x * v; cz += b.pos.z * v; }
      cx /= m; cz /= m;
      if (supported(cx, cz, [...sup].map(c => [c.pos.x, c.pos.z]))) continue;
      const rec = makeDynamic(comp);
      rec.toppling = true;
      sound('crack', 2); sound('rumble', 3);
      return true;
    }
  }
  return false;
}

function startFailing(b, delay) {
  if (b.state !== 'static') return;
  b.state = 'failing'; b.failAt = simTime + delay; b.failStart = simTime;
  sound('crack', 0.8);
}

// ---------- 땅과 이어져 있는지 ----------
function freeDisconnected() {
  // 아래가 비어 버린 기둥은 위 판에 매달리지 않고 떨어짐
  const hanging = blocks.filter(b => b.type === 'col' && standing(b) && !b.bearing);
  for (const c of hanging) { if (c.state === 'failing') shatter(c); else makeDynamic([c]); }
  if (hanging.length) return true;
  const seen = new Set();
  const queue = [];
  for (let i = 0; i < GX; i++) for (let j = 0; j < GZ; j++) { const c = col(0, i, j); if (standing(c)) { seen.add(c); queue.push(c); } }
  while (queue.length) {
    const b = queue.pop();
    for (const n of neighbors(b)) if (standing(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
  }
  const loose = blocks.filter(b => standing(b) && !seen.has(b));
  if (!loose.length) return false;
  const done = new Set();
  for (const start of loose) {
    if (done.has(start)) continue;
    const comp = [start]; done.add(start);
    for (let q = 0; q < comp.length; q++) for (const n of neighbors(comp[q])) if (standing(n) && !seen.has(n) && !done.has(n)) { done.add(n); comp.push(n); }
    for (const b of comp.filter(b => b.state === 'failing')) shatter(b);
    const rest = comp.filter(b => b.state === 'static');
    if (rest.length) makeDynamic(rest);
  }
  return true;
}

// ---------- 정적 블록 → 강체 ----------
function retireStatic(b) {
  colliderInfo.delete(b.collider.handle);
  world.removeRigidBody(b.body);
  b.body = null; b.collider = null;
  scene.remove(b.mesh);
}

function newBody(pos, quat, lin, ang) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(pos.x, pos.y, pos.z).setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
    .setLinearDamping(0.05).setAngularDamping(0.2).setCanSleep(true));
  if (lin) body.setLinvel(lin, true);
  if (ang) body.setAngvel(ang, true);
  const group = new THREE.Group();
  group.position.copy(pos); group.quaternion.copy(quat);
  scene.add(group);
  const rec = { body, group, pieces: [], prevVel: new THREE.Vector3(lin?.x || 0, lin?.y || 0, lin?.z || 0), born: simTime };
  bodies.push(rec);
  return rec;
}

function addPiece(rec, mesh, half, localPos, localQuat) {
  mesh.position.copy(localPos);
  if (localQuat) mesh.quaternion.copy(localQuat); else mesh.quaternion.identity();
  rec.group.add(mesh);
  const desc = RAPIER.ColliderDesc.cuboid(Math.max(0.02, half.x - GAP), Math.max(0.02, half.y - GAP), Math.max(0.02, half.z - GAP))
    .setTranslation(localPos.x, localPos.y, localPos.z)
    .setRotation(localQuat ? { x: localQuat.x, y: localQuat.y, z: localQuat.z, w: localQuat.w } : { x: 0, y: 0, z: 0, w: 1 })
    .setDensity(STRUCT_DENSITY).setFriction(0.8).setRestitution(0.05)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setCollisionGroups(G_ALL);
  const collider = world.createCollider(desc, rec.body);
  const piece = { mesh, half: half.clone(), collider, mass: 8 * half.x * half.y * half.z * STRUCT_DENSITY };
  colliderInfo.set(collider.handle, { rec, piece });
  rec.pieces.push(piece);
}

// 땅과 끊긴 덩어리를 통째로 하나의 강체로
function makeDynamic(comp, lin) {
  const c = new THREE.Vector3();
  for (const b of comp) c.add(b.pos);
  c.divideScalar(comp.length);
  const rec = newBody(c, new THREE.Quaternion(), lin);
  for (const b of comp) {
    retireStatic(b);
    b.state = 'dynamic';
    b.mesh.material.color.copy(b.type === 'col' ? C_COL : C_TILE);
    addPiece(rec, b.mesh, b.half, b.pos.clone().sub(c));
  }
  rec.compound = comp.length > 1;
  for (const b of comp) puff(b.pos, 6, 1.2);
  sound('rumble', Math.min(3, comp.length * 0.3));
  dirty = true;
  return rec;
}

// 부러진 블록: 조각 여러 개로
function shatter(b, push) {
  const base = b.mesh.material.color.clone();
  retireStatic(b);
  b.state = 'broken';
  const n = b.type === 'col' ? [1, 3, 1] : [2, 1, 2];
  const h = new THREE.Vector3(b.half.x / n[0], b.half.y / n[1], b.half.z / n[2]);
  for (let x = 0; x < n[0]; x++) for (let y = 0; y < n[1]; y++) for (let z = 0; z < n[2]; z++) {
    const p = new THREE.Vector3(
      b.pos.x - b.half.x + h.x * (2 * x + 1),
      b.pos.y - b.half.y + h.y * (2 * y + 1),
      b.pos.z - b.half.z + h.z * (2 * z + 1));
    const s = b.type === 'col' ? 0.55 + Math.random() * 0.2 : 0.82 + Math.random() * 0.12; // 기둥 조각은 작게 부서져서 위를 받치지 못함
    const ph = h.clone().multiplyScalar(s);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(ph.x * 2, ph.y * 2, ph.z * 2), new THREE.MeshStandardMaterial({ color: base.lerp(b.type === 'col' ? C_COL : C_TILE, 0.6), roughness: 0.95 }));
    mesh.castShadow = mesh.receiveShadow = true;
    const kick = { x: (Math.random() - 0.5) * 1.5, y: Math.random() * 0.8, z: (Math.random() - 0.5) * 1.5 };
    if (push) { const s = 0.6 + Math.random() * 0.6; kick.x += push.x * s; kick.y += push.y * s; kick.z += push.z * s; }
    const spin = { x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 3, z: (Math.random() - 0.5) * 3 };
    const rec = newBody(p, new THREE.Quaternion(), kick, spin);
    addPiece(rec, mesh, ph, new THREE.Vector3());
  }
  puff(b.pos, b.type === 'col' ? 40 : 70, b.type === 'col' ? 0.8 : 2.5);
  sound('crack', 1.4); sound('rumble', 0.8);
  dirty = true;
}

// 덩어리 강체가 세게 부딪히면 블록별로 쪼갬
function splitCompound(rec) {
  const v = rec.body.linvel(), w = rec.body.angvel(), o = rec.body.translation();
  const W = new THREE.Vector3(w.x, w.y, w.z), O = new THREE.Vector3(o.x, o.y, o.z);
  const pieces = rec.pieces.slice();
  removeBody(rec);
  for (const p of pieces) {
    p.mesh.getWorldPosition(tmpV); p.mesh.getWorldQuaternion(tmpQ);
    const r = tmpV.clone().sub(O);
    const pv = new THREE.Vector3(v.x, v.y, v.z).add(W.clone().cross(r));
    const nr = newBody(tmpV.clone(), tmpQ.clone(), pv, w);
    addPiece(nr, p.mesh, p.half, new THREE.Vector3());
    puff(tmpV, 5, 1);
  }
  sound('rumble', 2);
}

function removeBody(rec) {
  for (const p of rec.pieces) colliderInfo.delete(p.collider.handle);
  world.removeRigidBody(rec.body);
  scene.remove(rec.group);
  bodies.splice(bodies.indexOf(rec), 1);
}

// ---------- 기둥 빼기 ----------
function removeColumn(b, dir) {
  if (!b || b.type !== 'col' || b.state !== 'static') return false;
  const d = dir ? dir.clone().setY(0).normalize() : new THREE.Vector3(1, 0, 0);
  const rec = makeDynamic([b], { x: d.x * 5, y: 0.5, z: d.z * 5 });
  rec.pieces[0].collider.setCollisionGroups(G_PULLED);
  rec.pulledUntil = simTime + 0.8;
  removed++;
  sound('crack', 1);
  return true;
}

// ---------- 철퇴: 크레인 끝에 줄로 매단 쇠공 ----------
const ANCHOR_Y = 17, BALL_R = 0.9, BALL_DENSITY = 14; // 밀도 7 → 14 (2배)
const BALL_MASS = BALL_DENSITY * 4 / 3 * Math.PI * BALL_R ** 3;
const CRANE_SPEED = 16;      // 크레인 끝이 따라가는 최고 속도 (m/s) — 공이 늦게 따라오며 흔들림
const MAST = new THREE.Vector3(-20, 0, -16);
let mode = 'pick', shake = 0;
const crane = {
  anchor: new THREE.Vector3(14, ANCHOR_Y, 10), target: new THREE.Vector3(14, ANCHOR_Y, 10),
  len: 9, lenTarget: 9, ball: null, prevVel: new THREE.Vector3(), hits: 0,
};
const craneGroup = new THREE.Group();
// 가시 철퇴: 정이십면체 꼭짓점 12개(긴 가시) + 면 중심 20개(짧은 가시)
const SPIKES = (() => {
  const g = new THREE.IcosahedronGeometry(1, 0), pos = g.attributes.position, out = [], seen = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
    if (!seen.some(s => s.distanceTo(v) < 1e-3)) { seen.push(v); out.push({ dir: v, len: 0.75 }); }
  }
  for (let i = 0; i < pos.count; i += 3) {
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(pos, i + k));
    out.push({ dir: c.normalize(), len: 0.5 });
  }
  return out;
})();
const ironMat = new THREE.MeshStandardMaterial({ color: '#3a3a3c', metalness: 0.7, roughness: 0.35 });
const ballMesh = new THREE.Group();
ballMesh.add(new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 2), ironMat));
for (const s of SPIKES) {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, s.len, 8), ironMat);
  cone.position.copy(s.dir).multiplyScalar(BALL_R + s.len / 2 - 0.08);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.dir);
  ballMesh.add(cone);
}
ballMesh.traverse(o => { o.castShadow = true; });
const cableGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const cable = new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: '#2c2c2a' }));
cable.frustumCulled = false;
const yellow = new THREE.MeshStandardMaterial({ color: '#e0a526', roughness: 0.6 });
const mast = new THREE.Mesh(new THREE.BoxGeometry(1, ANCHOR_Y + 2, 1), yellow);
mast.position.set(MAST.x, (ANCHOR_Y + 2) / 2, MAST.z);
const boom = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 1), yellow);
const trolley = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.9), yellow);
mast.castShadow = boom.castShadow = trolley.castShadow = true;
craneGroup.add(ballMesh, cable, mast, boom, trolley);

function spawnBall() {
  const p = crane.anchor.clone(); p.y -= crane.len;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
    .setCcdEnabled(true).setCanSleep(false).setLinearDamping(0.12).setAngularDamping(0.5));
  const c = world.createCollider(RAPIER.ColliderDesc.ball(BALL_R).setDensity(BALL_DENSITY).setFriction(0.4).setRestitution(0.1).setCollisionGroups(G_ALL)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
  colliderInfo.set(c.handle, { ball: true });
  // 가시 끝 쪽에 작은 충돌 구 (질량 없음) → 가시가 먼저 닿음
  for (const s of SPIKES) {
    const tip = s.dir.clone().multiplyScalar(BALL_R + s.len * 0.55);
    const sc = world.createCollider(RAPIER.ColliderDesc.ball(0.17).setTranslation(tip.x, tip.y, tip.z).setDensity(0).setCollisionGroups(G_ALL)
      .setFriction(0.6).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
    colliderInfo.set(sc.handle, { ball: true });
  }
  crane.ball = body;
  crane.prevVel.set(0, 0, 0);
}

function setMode(m) {
  mode = m;
  document.getElementById('mPick').classList.toggle('on', m === 'pick');
  document.getElementById('mWreck').classList.toggle('on', m === 'wreck');
  document.getElementById('mBlast').classList.toggle('on', m === 'blast');
  document.getElementById('hint').innerHTML = {
    pick: '기둥 클릭 = 빼기 · 드래그 = 돌려 보기',
    wreck: '마우스 이동 = 크레인 움직이기 (휘두르면 철퇴가 흔들림)<br>Q / E = 줄 감기 / 풀기 · 드래그 = 돌려 보기',
    blast: '지연 시간을 고르고 기둥 클릭 = 폭약 붙이기 / 떼기<br>목표: 잔해를 초록 구역 안에 떨어뜨리기',
  }[m];
  document.getElementById('blastPanel').style.display = m === 'blast' ? '' : 'none';
  if (m === 'blast') scene.add(zoneGroup); else scene.remove(zoneGroup);
  if (m === 'wreck') {
    scene.add(craneGroup);
    if (!crane.ball) spawnBall();
  } else {
    scene.remove(craneGroup);
    if (crane.ball) { world.removeRigidBody(crane.ball); crane.ball = null; }
  }
  hover = null;
}

function craneStep() {
  if (!crane.ball) return;
  const d = crane.target.clone().sub(crane.anchor);
  const maxMove = CRANE_SPEED * DT;
  if (d.length() > maxMove) d.setLength(maxMove);
  crane.anchor.add(d);
  crane.len += Math.sign(crane.lenTarget - crane.len) * Math.min(Math.abs(crane.lenTarget - crane.len), 6 * DT);
  const v = crane.ball.linvel();
  crane.prevVel.set(v.x, v.y, v.z);
}

// 줄은 늘어나지 않음: 길이를 넘으면 당겨 붙이고 바깥 방향 속도를 없앰
function ropeConstraint() {
  if (!crane.ball) return;
  const p = crane.ball.translation();
  const d = new THREE.Vector3(p.x, p.y, p.z).sub(crane.anchor);
  const L = d.length();
  if (L <= crane.len) return;
  d.divideScalar(L);
  const np = crane.anchor.clone().addScaledVector(d, crane.len);
  crane.ball.setTranslation({ x: np.x, y: np.y, z: np.z }, true);
  const v = crane.ball.linvel();
  const vr = v.x * d.x + v.y * d.y + v.z * d.z;
  if (vr > 0) crane.ball.setLinvel({ x: v.x - vr * d.x, y: v.y - vr * d.y, z: v.z - vr * d.z }, true);
}

function ballHit(other) {
  const v = crane.prevVel, speed = v.length();
  if (speed < 1.5) return;
  const E = 0.5 * BALL_MASS * speed * speed;
  const p = crane.ball.translation();
  if (simTime - (crane.lastFx ?? -1) > 0.12) { // 가시 여러 개 접촉 → 효과는 한 번만
    crane.lastFx = simTime;
    puff(tmpV.set(p.x, p.y, p.z), Math.min(40, 5 + E / 20), 1.2);
    shake = Math.max(shake, Math.min(1, E / 700));
    sound('rumble', Math.min(2.5, E / 250));
  }
  const b = other.block;
  if (!b || !standing(b)) return;
  // 가시 여러 개가 한꺼번에 닿아도 한 번의 타격으로 침
  if (b.lastBallHit !== undefined && simTime - b.lastBallHit < 0.2) return;
  b.lastBallHit = simTime;
  b.damage += E;
  crane.hits++;
  if (b.damage > IMPACT_CAP[b.type]) {
    shatter(b, v.clone().multiplyScalar(0.6));
    crane.ball.setLinvel({ x: v.x * 0.75, y: v.y * 0.75, z: v.z * 0.75 }, true); // 부수고 뚫고 지나감
  } else {
    sound('crack', 0.5 + E / 300);
    dirty = true;
  }
}

// ---------- 발파 해체 ----------
const DELAYS = [0, 0.5, 1, 1.5];
const DELAY_COLORS = ['#e04030', '#f08a24', '#e6c229', '#8a6ad8'];
const ZONE_MARGIN = 3;       // 목표 구역 = 건물 자리 + 3 m
const ZONE_HALF_X = (GX - 1) / 2 * SPAN + CW / 2 + ZONE_MARGIN, ZONE_HALF_Z = (GZ - 1) / 2 * SPAN + CW / 2 + ZONE_MARGIN;
const BLAST_RADIUS = 3.5, BLAST_DAMAGE = 220;
const blast = { delayIdx: 0, active: false, t0: 0, endAt: 0, used: 0 };
const zoneGroup = new THREE.Group();
{
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(ZONE_HALF_X * 2, ZONE_HALF_Z * 2),
    new THREE.MeshBasicMaterial({ color: '#5aa860', transparent: true, opacity: 0.22, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2; plane.position.y = 0.02;
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-ZONE_HALF_X, 0.04, -ZONE_HALF_Z), new THREE.Vector3(ZONE_HALF_X, 0.04, -ZONE_HALF_Z),
    new THREE.Vector3(ZONE_HALF_X, 0.04, ZONE_HALF_Z), new THREE.Vector3(-ZONE_HALF_X, 0.04, ZONE_HALF_Z)]),
    new THREE.LineBasicMaterial({ color: '#2f7a37' }));
  zoneGroup.add(plane, edge);
}
const flash = new THREE.PointLight('#ffb060', 0, 40, 1.5);
scene.add(flash);

function setDelay(i) {
  blast.delayIdx = i;
  DELAYS.forEach((_, k) => document.getElementById('d' + k).classList.toggle('on', k === i));
}

function toggleCharge(b) {
  if (blast.active || !b || b.type !== 'col' || b.state !== 'static') return;
  if (b.charge) { b.mesh.remove(b.charge.mesh); b.charge = null; return; }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.6, 0.34),
    new THREE.MeshStandardMaterial({ color: DELAY_COLORS[blast.delayIdx], roughness: 0.5, emissive: DELAY_COLORS[blast.delayIdx], emissiveIntensity: 0.25 }));
  // 바깥쪽 면에 붙임 (안쪽 기둥은 앞면)
  const ox = Math.sign(b.pos.x), oz = Math.sign(b.pos.z) || (ox ? 0 : 1);
  mesh.position.set(ox * (CW / 2 + 0.12), -0.4, oz * (CW / 2 + 0.12));
  mesh.castShadow = true;
  b.mesh.add(mesh);
  b.charge = { delay: DELAYS[blast.delayIdx], mesh, fired: false };
  sound('crack', 0.3);
}

function detonate() {
  const armed = blocks.filter(b => b.charge && b.state === 'static');
  if (blast.active || !armed.length) return;
  blast.active = true; blast.t0 = simTime; blast.used = armed.length;
  blast.endAt = simTime + Math.max(...armed.map(b => b.charge.delay)) + 7;
  document.getElementById('result').textContent = '발파 중…';
}

function explode(b) {
  const pos = b.pos.clone();
  sound('boom', 3); sound('crack', 2);
  flash.position.copy(pos); flash.intensity = 600;
  shake = 1;
  puff(pos, 140, 1.6);
  const out = new THREE.Vector3(pos.x, 0, pos.z);
  if (out.lengthSq() < 0.01) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
  out.normalize().multiplyScalar(4).setY(1);
  shatter(b, out);
  // 주변 블록에도 충격
  for (const o of blocks) {
    if (!standing(o)) continue;
    const d = o.pos.distanceTo(pos);
    if (d < BLAST_RADIUS) { o.damage += BLAST_DAMAGE * (1 - d / BLAST_RADIUS); dirty = true; }
  }
  for (const rec of bodies) {
    const t = rec.body.translation();
    const dir = new THREE.Vector3(t.x - pos.x, t.y - pos.y, t.z - pos.z);
    const d = dir.length();
    if (d > 5 || d < 1e-3) continue;
    dir.normalize().multiplyScalar(rec.body.mass() * 3 * (1 - d / 5));
    rec.body.applyImpulse({ x: dir.x, y: dir.y, z: dir.z }, true);
  }
}

function blastStep() {
  if (!blast.active) return;
  const elapsed = simTime - blast.t0;
  for (const b of blocks) {
    if (!b.charge || b.charge.fired || elapsed < b.charge.delay) continue;
    b.charge.fired = true;
    if (standing(b)) explode(b);
  }
  if (simTime >= blast.endAt) { blast.active = false; scoreBlast(); }
}

// 잔해 질량 중 몇 %가 목표 구역 안에 있는지
function scoreBlast() {
  let inside = 0, total = 0;
  for (const rec of bodies) for (const p of rec.pieces) {
    p.mesh.getWorldPosition(tmpV);
    total += p.mass;
    if (Math.abs(tmpV.x) <= ZONE_HALF_X && Math.abs(tmpV.z) <= ZONE_HALF_Z) inside += p.mass;
  }
  const left = blocks.filter(standing).length, pct = total ? Math.round(inside / total * 100) : 0;
  let verdict;
  if (left > blocks.length / 2) verdict = '실패 — 건물이 절반 넘게 남았어요';
  else if (pct >= 90 && left <= 3 && blast.used <= 8) verdict = '★★★ 깔끔한 발파';
  else if (pct >= 90 && left <= 3) verdict = '★★ 깔끔해요 — 폭약 8개 이하로 해 보세요';
  else if (pct >= 75 && left <= 15) verdict = '★★ 괜찮아요';
  else verdict = '★ 잔해가 흩어졌거나 많이 남았어요';
  document.getElementById('result').innerHTML = `${verdict}<br>구역 안 잔해 ${pct}% · 남은 블록 ${left}개 · 폭약 ${blast.used}개`;
  return { pct, left, used: blast.used };
}

// ---------- 입력 ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let hover = null, downAt = null;
function pick(e) {
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const meshes = blocks.filter(b => b.state === 'static' || b.state === 'failing').map(b => b.mesh);
  const hit = ray.intersectObjects(meshes, false)[0];
  const b = hit?.object.userData.block;
  return b && b.type === 'col' ? b : null;
}
// 철퇴: 커서가 가리키는 곳(공 높이의 수평면)으로 크레인 끝을 보냄
function aim(e) {
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  aimPlane.constant = -(ANCHOR_Y - crane.len);
  const p = ray.ray.intersectPlane(aimPlane, tmpV);
  if (!p) return;
  const r = Math.hypot(p.x, p.z);
  if (r > 30) { p.x *= 30 / r; p.z *= 30 / r; }
  crane.target.set(p.x, ANCHOR_Y, p.z);
}
renderer.domElement.addEventListener('pointermove', e => {
  if (mode === 'wreck') { if (e.buttons === 0) aim(e); return; }
  hover = pick(e); renderer.domElement.style.cursor = hover ? 'pointer' : '';
});
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (mode === 'wreck' || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const b = pick(e);
  if (mode === 'blast') toggleCharge(b);
  else if (b) removeColumn(b, ray.ray.direction);
});
function toggleStress() { showStress = !showStress; document.getElementById('stress').classList.toggle('on', showStress); }
document.getElementById('reset').onclick = build;
document.getElementById('stress').onclick = toggleStress;
document.getElementById('mPick').onclick = () => setMode('pick');
document.getElementById('mWreck').onclick = () => setMode('wreck');
document.getElementById('mBlast').onclick = () => setMode('blast');
document.getElementById('fire').onclick = detonate;
DELAYS.forEach((_, k) => { document.getElementById('d' + k).onclick = () => setDelay(k); });
addEventListener('keydown', e => {
  if (e.key === 'r' || e.key === 'R') build();
  if (e.key === 'l' || e.key === 'L') toggleStress();
  if (e.key === '1') setMode('pick');
  if (e.key === '2') setMode('wreck');
  if (e.key === '3') setMode('blast');
  if (e.key === ' ' && mode === 'blast') { e.preventDefault(); detonate(); }
  if (e.key === 'q' || e.key === 'Q') crane.lenTarget = Math.max(3, crane.lenTarget - 1.5);
  if (e.key === 'e' || e.key === 'E') crane.lenTarget = Math.min(15, crane.lenTarget + 1.5);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- 한 스텝 ----------
const DT = 1 / 60;
function step() {
  simTime += DT;
  for (const rec of bodies) { const v = rec.body.linvel(); rec.prevVel.set(v.x, v.y, v.z); }
  craneStep();
  world.timestep = DT;
  world.step(eventQueue);
  ropeConstraint();

  // 충돌: 떨어진 덩어리가 서 있는 블록을 때리면 손상 누적
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const A = colliderInfo.get(h1), B = colliderInfo.get(h2);
    if (!A || !B) return;
    if (A.ball || B.ball) { if (crane.ball) ballHit(A.ball ? B : A); return; }
    for (const [dyn, other] of [[A, B], [B, A]]) {
      if (!dyn.rec) continue;
      // 넘어가는 덩어리: 깔린 기둥은 버티다 꺾이고, 땅에 닿으면 곧 부서짐
      if (dyn.rec.toppling) {
        const ob = other.block;
        if (ob && ob.type === 'col') (dyn.rec.pivots ??= new Set()).add(ob);
        if (other.ground && !dyn.rec.splitAt) dyn.rec.splitAt = simTime + 0.12;
      }
      const speed = dyn.rec.prevVel.length();
      if (speed < 2.5) continue;
      const E = 0.5 * dyn.piece.mass * speed * speed;
      if (other.block && other.block.state === 'static') {
        other.block.damage += E;
        dirty = true;
      }
      if (speed > 4) {
        dyn.piece.mesh.getWorldPosition(tmpV);
        puff(tmpV, Math.min(30, 4 + E / 15), 1.2);
        if (other.ground) sound('rumble', Math.min(2, E / 120));
      }
    }
  });

  // 덩어리 강체가 급정거하면(=세게 부딪힘) 쪼갬
  for (const rec of bodies.slice()) {
    if (!rec.compound || simTime - rec.born < 0.1) continue;
    if (rec.splitAt && simTime >= rec.splitAt) { splitCompound(rec); continue; }
    if (rec.toppling) { // 충분히 기운 뒤 무언가에 기대어 회전이 멈추면 부서짐
      const q = rec.body.rotation(), w = rec.body.angvel();
      const tilt = Math.acos(Math.min(1, Math.abs(1 - 2 * (q.x * q.x + q.z * q.z))));
      // 확실히 기울기 시작하면 깔린 기둥(축)이 버티다 꺾임
      if (tilt > 0.1 && rec.pivots) for (const c of rec.pivots) if (c.state === 'static') startFailing(c, 0.5 + Math.random() * 0.4);
      if (tilt > 0.2 && Math.hypot(w.x, w.y, w.z) < 0.25) { splitCompound(rec); continue; }
    }
    const v = rec.body.linvel();
    const dv = Math.hypot(v.x - rec.prevVel.x, v.y - rec.prevVel.y, v.z - rec.prevVel.z);
    if (dv > 3.5) splitCompound(rec);
  }

  for (const rec of bodies) if (rec.pulledUntil && simTime > rec.pulledUntil) {
    rec.pulledUntil = 0;
    for (const p of rec.pieces) p.collider.setCollisionGroups(G_ALL);
  }

  // 부러지는 중인 블록 → 시간이 되면 쪼개짐
  for (const b of blocks) if (b.state === 'failing' && simTime >= b.failAt) shatter(b);
  blastStep();

  // 바뀐 게 있으면 하중·연결 다시 계산 (빠지는 것이 없을 때까지)
  if (dirty) {
    dirty = false;
    for (let guard = 0; guard < 10; guard++) {
      computeLoads();
      if (freeDisconnected()) continue;
      if (checkTopple()) continue;
      markFailures();
      break;
    }
  }

  // 땅 아래로 빠진 것 정리
  for (const rec of bodies.slice()) if (rec.body.translation().y < -20) removeBody(rec);
}

// ---------- 그리기 ----------
function syncVisuals() {
  for (const rec of bodies) {
    const p = rec.body.translation(), q = rec.body.rotation();
    rec.group.position.set(p.x, p.y, p.z);
    rec.group.quaternion.set(q.x, q.y, q.z, q.w);
  }
  for (const b of blocks) {
    if (b.state === 'static') {
      const r = Math.max(b.ratio, b.damage / IMPACT_CAP[b.type]);
      b.mesh.material.color.copy(stressColor(b.type === 'col' ? C_COL : C_TILE, r, tmpC));
      b.mesh.position.copy(b.pos);
      b.mesh.material.emissive.setHex(b === hover ? 0x3a3020 : 0);
    } else if (b.state === 'failing') {
      // 부러지기 직전: 떨리면서 빨개짐
      const k = Math.min(1, (simTime - b.failStart) / Math.max(0.01, b.failAt - b.failStart));
      const a = 0.03 + 0.06 * k;
      b.mesh.position.set(b.pos.x + (Math.random() - 0.5) * a, b.pos.y + (Math.random() - 0.5) * a, b.pos.z + (Math.random() - 0.5) * a);
      b.mesh.material.color.copy(C_DANGER);
      b.mesh.material.emissive.setHex(0);
    }
  }
  if (crane.ball) {
    const p = crane.ball.translation(), q = crane.ball.rotation();
    ballMesh.position.set(p.x, p.y, p.z);
    ballMesh.quaternion.set(q.x, q.y, q.z, q.w);
    const pos = cableGeo.attributes.position;
    pos.setXYZ(0, crane.anchor.x, crane.anchor.y, crane.anchor.z);
    pos.setXYZ(1, p.x, p.y + BALL_R * 0.9, p.z);
    pos.needsUpdate = true;
    trolley.position.copy(crane.anchor);
    const top = new THREE.Vector3(MAST.x, ANCHOR_Y + 0.3, MAST.z);
    boom.position.copy(top).add(crane.anchor).multiplyScalar(0.5);
    boom.position.y = ANCHOR_Y + 0.3;
    boom.lookAt(crane.anchor.x, ANCHOR_Y + 0.3, crane.anchor.z);
    boom.scale.z = Math.hypot(crane.anchor.x - MAST.x, crane.anchor.z - MAST.z) + 0.5;
  }
  const down = blocks.filter(b => !standing(b)).length;
  document.getElementById('count').textContent = `${down} / ${blocks.length}`;
}

let last = performance.now(), acc = 0, frameMs = 16;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  frameMs = frameMs * 0.9 + (now - last) * 0.1;
  last = now;
  acc += dt;
  let n = 0;
  while (acc >= DT && n < 3) { step(); acc -= DT; n++; }
  if (n === 3) acc = 0;
  updateDust(dt);
  syncVisuals();
  controls.update();
  // 큰 충격이면 화면이 잠깐 흔들림
  const sx = (Math.random() - 0.5) * shake * 0.4, sy = (Math.random() - 0.5) * shake * 0.4;
  camera.position.x += sx; camera.position.y += sy;
  renderer.render(scene, camera);
  camera.position.x -= sx; camera.position.y -= sy;
  shake *= Math.exp(-dt * 7);
  flash.intensity *= Math.exp(-dt * 12);
  requestAnimationFrame(frame);
}

build();
requestAnimationFrame(frame);

// 테스트용 손잡이
window.sim = {
  removeColumn: (k, i, j) => removeColumn(col(k, i, j)),
  step: (n = 1) => { for (let i = 0; i < n; i++) step(); syncVisuals(); renderer.render(scene, camera); },
  reset: build,
  mode: setMode,
  compounds: () => bodies.filter(r => r.compound).map(r => {
    const t = r.body.translation(), q = r.body.rotation();
    const tilt = Math.acos(Math.min(1, Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)))) * 180 / Math.PI;
    const lv = r.body.linvel(), av = r.body.angvel(), com = r.body.worldCom ? r.body.worldCom() : null;
    return `v(${lv.x.toFixed(2)},${lv.y.toFixed(2)}) w(${av.x.toFixed(2)},${av.z.toFixed(2)}) com${com ? `(${com.x.toFixed(1)},${com.y.toFixed(1)},${com.z.toFixed(1)})` : '?'} 충돌체${r.body.numColliders()} 블록${r.pieces.length} 잠${r.body.isSleeping()} 질량${r.body.mass().toFixed(0)} 위치(${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)}) 기울기${tilt.toFixed(0)}°`;
  }),
  charge: (k, i, j, d = 0) => { setDelay(DELAYS.indexOf(d)); toggleCharge(col(k, i, j)); },
  detonate, score: scoreBlast,
  zonePct: (margin) => {
    const hx = (GX - 1) / 2 * SPAN + CW / 2 + margin, hz = (GZ - 1) / 2 * SPAN + CW / 2 + margin;
    let a = 0, t = 0;
    for (const rec of bodies) for (const p of rec.pieces) { p.mesh.getWorldPosition(tmpV); t += p.mass; if (Math.abs(tmpV.x) <= hx && Math.abs(tmpV.z) <= hz) a += p.mass; }
    return Math.round(a / t * 100);
  },
  aimAt: (x, z) => crane.target.set(x, ANCHOR_Y, z),
  ball: () => { const p = crane.ball?.translation(); return p && { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), speed: +crane.prevVel.length().toFixed(1), hits: crane.hits }; },
  stats: () => ({
    static: blocks.filter(b => b.state === 'static').length,
    failing: blocks.filter(b => b.state === 'failing').length,
    dynamic: blocks.filter(b => b.state === 'dynamic').length,
    broken: blocks.filter(b => b.state === 'broken').length,
    bodies: bodies.length,
    maxRatio: +Math.max(...blocks.filter(standing).map(b => b.ratio)).toFixed(2),
    fps: Math.round(1000 / frameMs),
  }),
  ratios: () => blocks.filter(standing).map(b => `${b.type}${b.k}:${b.type === 'col' ? b.i + ',' + b.j : b.a + ',' + b.b}=${b.ratio.toFixed(2)}`),
};
