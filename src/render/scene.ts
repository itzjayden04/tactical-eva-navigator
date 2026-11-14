/**
 * 3D WORLD (Three.js). Reads simulation state every frame; never mutates it.
 */
import * as THREE from 'three';
import groundUrl from '../assets/ground.jpg';
import type { DataBundle } from '../data/types';
import { sample, slopeDeg } from '../core/grid';
import type { Sim } from '../core/sim';
import { fbm } from '../data/mockJezero';
import type { Guardian, Pick } from '../core/guardian';

const EYE = 1.75;
/** Base vertical field of view of the helmet visor (degrees) at 1x optical zoom. */
const BASE_FOV = 64;
/** Radial lens curvature of the visor (barrel). 0 = flat screen. */
export const VISOR_K = 0.075;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  droneCam: THREE.PerspectiveCamera;
  ref: number;
  yawOffset = 0;
  pitch = -0.05;
  /** optical zoom (scroll wheel); `zoom` eases toward `zoomTarget` */
  zoom = 1;
  zoomTarget = 1;
  private rt: THREE.WebGLRenderTarget;
  private lens: THREE.Mesh;
  private lensScene = new THREE.Scene();
  private lensCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private time = 0;
  private terrain!: THREE.Mesh;
  private worldGroup = new THREE.Group();
  private chevrons: THREE.InstancedMesh;
  private hazardRings = new THREE.Group();
  private drone: THREE.Group;
  private dust: THREE.Points;
  private sky!: THREE.Mesh;
  private bob = 0;
  private yaw = 0;
  private fog: THREE.FogExp2;
  private skyColor = new THREE.Color('#c9a27e');
  pipRect: DOMRect | null = null;
  private pipTarget: THREE.WebGLRenderTarget | null = null;
  private pipFrame = 0;
  private obstacleMesh: THREE.InstancedMesh | null = null;
  private guardian: Guardian | null = null;
  private entityMeshes = new Map<string, THREE.Object3D>();
  private goalRing!: THREE.Mesh;
  private cacheBeacons = new Map<string, THREE.Mesh>();
  /** 0..1 ground shaking (marsquake), set by the app each frame */
  quake = 0;
  private roll = 0;

  constructor(private container: HTMLElement, private data: DataBundle, private sim: Sim) {
    this.ref = -2600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, container.clientWidth / container.clientHeight, 0.1, 12000);
    // The scene renders into an HDR target; a full-screen "visor lens" pass then bends it
    // onto the curved helmet visor (barrel curvature + edge chromatic fringe + rim falloff).
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.lens = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        uniforms: { tScene: { value: this.rt.texture }, k: { value: VISOR_K }, aspect: { value: 1 }, time: { value: 0 }, flash: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D tScene; uniform float k; uniform float aspect; uniform float time; uniform float flash; varying vec2 vUv;
          vec2 warp(vec2 uv, float kk){ vec2 p = uv * 2.0 - 1.0; p.x *= aspect; float r2 = dot(p, p);
            p *= (1.0 + kk * r2) / (1.0 + kk * aspect * aspect); p.x /= aspect; return p * 0.5 + 0.5; }
          void main(){
            vec2 p = vUv * 2.0 - 1.0; p.x *= aspect; float r2 = dot(p, p);
            float ca = 0.012 * smoothstep(0.6, 3.2, r2);
            vec3 c;
            c.r = texture2D(tScene, warp(vUv, k * (1.0 + ca * 6.0))).r;
            c.g = texture2D(tScene, warp(vUv, k)).g;
            c.b = texture2D(tScene, warp(vUv, k * (1.0 - ca * 6.0))).b;
            // visor glass: faint cool tint, curved specular sweep, rim falloff
            float sweep = exp(-pow((vUv.x * 0.8 + vUv.y * 1.1 - 1.32) * 7.0, 2.0)) * smoothstep(0.35, 1.0, vUv.y);
            c += vec3(0.9, 0.95, 1.0) * sweep * 0.035;
            vec2 q = vec2((vUv.x - 0.5) / 0.56, (vUv.y - 0.47) / 0.6);
            float rim = smoothstep(0.78, 1.22, length(q));
            c *= 1.0 - rim * 0.88;
            c = mix(c, c * vec3(0.96, 0.99, 1.04), 0.5);
            c += vec3(1.0, 0.25, 0.2) * flash * rim;
            gl_FragColor = vec4(c, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.lens.frustumCulled = false;
    this.lensScene.add(this.lens);
    this.droneCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 12000);
    this.fog = new THREE.FogExp2(this.skyColor.getHex(), 0.00028);
    this.scene.fog = this.fog;
    this.scene.add(this.worldGroup);

    // lights: low morning sun from the east
    const sun = new THREE.DirectionalLight('#fff1dc', 2.6);
    sun.position.set(900, 420, -250);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight('#e8c39e', '#5a3420', 0.9));

    this.buildSky();
    this.buildTerrain();
    this.buildRocks();
    this.buildObstacles();
    this.sim.on('obstacles', () => this.buildObstacles());
    this.buildTrack();
    this.buildPois();

    // route chevrons (both modes)
    const chevShape = new THREE.Shape();
    chevShape.moveTo(-0.9, -0.5);
    chevShape.lineTo(0, 0.5);
    chevShape.lineTo(0.9, -0.5);
    chevShape.lineTo(0.9, -0.1);
    chevShape.lineTo(0, 0.9);
    chevShape.lineTo(-0.9, -0.1);
    chevShape.closePath();
    const chevGeo = new THREE.ShapeGeometry(chevShape);
    chevGeo.rotateX(-Math.PI / 2);
    chevGeo.rotateY(Math.PI);
    const chevMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    this.chevrons = new THREE.InstancedMesh(chevGeo, chevMat, 72);
    this.chevrons.setColorAt(0, new THREE.Color('#39d0ff'));
    // pulsing ring on the ground where the guide path ends up (next waypoint, cache or tag)
    const ringGeo = new THREE.RingGeometry(1.5, 1.9, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.goalRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#39d0ff', transparent: true, opacity: 0.8, depthWrite: false, fog: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    this.goalRing.renderOrder = 5;
    this.goalRing.visible = false;
    this.scene.add(this.goalRing);
    this.chevrons.frustumCulled = false;
    this.chevrons.renderOrder = 5;
    this.scene.add(this.chevrons);
    this.scene.add(this.hazardRings);

    // drone
    this.drone = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.5), new THREE.MeshStandardMaterial({ color: '#d8d8d8', metalness: 0.4, roughness: 0.4 }));
    this.drone.add(body);
    for (const y of [0.25, 0.4]) {
      const rotor = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.02, 0.08), new THREE.MeshStandardMaterial({ color: '#333' }));
      rotor.position.y = y;
      rotor.name = 'rotor';
      this.drone.add(rotor);
    }
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshBasicMaterial({ color: '#39d0ff' }));
    lamp.position.y = -0.15;
    this.drone.add(lamp);
    this.drone.scale.setScalar(2.2);
    this.drone.visible = false;
    this.scene.add(this.drone);

    // dust particles around the camera
    const n = 2500;
    const pos = new Float32Array(n * 3);
    const r = rng(7);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (r() - 0.5) * 80;
      pos[i * 3 + 1] = r() * 25;
      pos[i * 3 + 2] = (r() - 0.5) * 80;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: '#d7a77c', size: 0.07, map: dotTexture(), transparent: true, opacity: 0, depthWrite: false }));
    this.scene.add(this.dust);

    window.addEventListener('resize', () => this.resize());
  }

  y(e: number, n: number) {
    return sample(this.data.elevation, e, n) - this.ref;
  }
  /** world (e,n) → three.js vector; three.js uses x=east, z=-north */
  v(e: number, n: number, up = 0) {
    return new THREE.Vector3(e, this.y(e, n) + up, -n);
  }

  private buildSky() {
    const geo = new THREE.SphereGeometry(8000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color('#6e4a36') }, horizon: { value: new THREE.Color('#d9b08a') }, sunDir: { value: new THREE.Vector3(900, 420, -250).normalize() }, dust: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform float dust; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0); c += vec3(0.55,0.62,0.75) * pow(s, 180.0) * 2.0; c += vec3(0.35,0.3,0.28) * pow(s, 8.0) * 0.35;
        c = mix(c, horizon * 0.9, dust); gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.sky);
  }

  private buildTerrain() {
    const g = this.data.elevation;
    const sizeE = g.cell * (g.width - 1);
    const sizeN = g.cell * (g.height - 1);
    const geo = new THREE.PlaneGeometry(sizeE, sizeN, g.width - 1, g.height - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const cx = g.originE + sizeE / 2;
    const cn = g.originN - sizeN / 2;
    const base = new THREE.Color('#a8603a');
    const dark = new THREE.Color('#5c3a28');
    const light = new THREE.Color('#c8925f');
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const e = pos.getX(i) + cx;
      const n = -pos.getZ(i) + cn;
      pos.setY(i, sample(g, e, n) - this.ref);
      pos.setX(i, e);
      pos.setZ(i, -n);
      const rock = this.data.rocks ? sample(this.data.rocks, e, n) : 0.2;
      const dust = sample(this.data.dust, e, n);
      const sl = slopeDeg(g, e, n);
      tmp.copy(base).lerp(dark, Math.min(1, rock * 0.7 + sl / 40)).lerp(light, Math.min(0.6, Math.max(0, dust - 0.8) * 0.35));
      const nz = 0.9 + 0.2 * fbm(e / 40, n / 40, 77, 3);
      colors[i * 3] = tmp.r * nz;
      colors[i * 3 + 1] = tmp.g * nz;
      colors[i * 3 + 2] = tmp.b * nz;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    // ground detail texture (photographic regolith, mirrored to hide seams)
    const tex = new THREE.TextureLoader().load(groundUrl);
    tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
    tex.repeat.set(sizeE / 9, sizeN / 9);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.97, metalness: 0 });
    this.terrain = new THREE.Mesh(geo, mat);
    this.worldGroup.add(this.terrain);
  }

  private buildRocks() {
    const r = rng(42);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: '#6b4431', roughness: 0.95, flatShading: true });
    const max = 9000;
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    let count = 0;
    const place = (e: number, n: number, size: number) => {
      if (count >= max) return;
      q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
      s.set(size * (0.7 + r() * 0.6), size * (0.35 + r() * 0.4), size * (0.7 + r() * 0.6));
      p.set(e, this.y(e, n) + s.y * 0.3, -n);
      m.compose(p, q, s);
      mesh.setMatrixAt(count++, m);
    };
    // near-track rocks give a sense of scale
    for (const g of this.sim.world.edges.values()) {
      for (const smp of g.samples) {
        const rock = this.data.rocks ? sample(this.data.rocks, smp.e, smp.n) : 0.2;
        const k = Math.floor(rock * 6 + r() * 1.5);
        for (let i = 0; i < k; i++) {
          const a = r() * Math.PI * 2;
          const d = 4 + r() * 45;
          const size = Math.min(0.12 + d * 0.03, 0.08 + Math.pow(r(), 3) * (0.5 + rock * 1.6));
          place(smp.e + Math.cos(a) * d, smp.n + Math.sin(a) * d, Math.min(size, 0.3));
        }
      }
    }
    // scattered boulders across the map
    const g = this.data.elevation;
    while (count < max) {
      const e = g.originE + r() * g.cell * (g.width - 1);
      const n = g.originN - r() * g.cell * (g.height - 1);
      const rock = this.data.rocks ? sample(this.data.rocks, e, n) : 0.2;
      if (r() > rock + 0.05) continue;
      place(e, n, 0.1 + Math.pow(r(), 2) * 0.25);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    this.worldGroup.add(mesh);
  }

  private buildTrack() {
    // faint trail line
    for (const g of this.sim.world.edges.values()) {
      const pts = g.samples.map((s) => this.v(s.e, s.n, 0.06));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#e9c19a', transparent: true, opacity: 0.16 }));
      this.worldGroup.add(line);
    }
  }

  /** Real boulders and rockfall rubble: the same objects the simulation collides with. */
  private buildObstacles() {
    const all = this.sim.obstacles.all;
    if (this.obstacleMesh) {
      this.worldGroup.remove(this.obstacleMesh);
      this.obstacleMesh.dispose();
    }
    const mesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true }), all.length);
    const r = rng(99);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const col = new THREE.Color();
    all.forEach((o, i) => {
      q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.5));
      sc.set(o.r * 1.02, o.h * 0.72, o.r * (0.85 + r() * 0.3));
      pos.set(o.e, this.y(o.e, o.n) + o.h * 0.3, -o.n);
      m.compose(pos, q, sc);
      mesh.setMatrixAt(i, m);
      const v = 0.85 + r() * 0.3;
      if (o.kind === 'rubble') col.setRGB(0.62 * v, 0.36 * v, 0.24 * v);
      else col.setRGB(0.42 * v, 0.27 * v, 0.19 * v);
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.obstacleMesh = mesh;
    this.worldGroup.add(mesh);
  }

  /** Crewmate and rover models, driven by the guardian's entity list. */
  attachGuardian(g: Guardian) {
    this.guardian = g;
    for (const en of g.entities) {
      const grp = new THREE.Group();
      const white = new THREE.MeshStandardMaterial({ color: '#f1f1f1', roughness: 0.55 });
      if (en.kind === 'teammate') {
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.85, 4, 10), white);
        body.position.y = 0.95;
        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 10), white);
        helmet.position.y = 1.75;
        const visor = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshStandardMaterial({ color: '#c58a2b', metalness: 0.9, roughness: 0.2 }));
        visor.position.set(0, 1.76, -0.13);
        const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.25), white);
        pack.position.set(0, 1.2, 0.3);
        const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.035, 6, 16), new THREE.MeshBasicMaterial({ color: '#4da3ff' }));
        stripe.rotation.x = Math.PI / 2;
        stripe.position.y = 1.25;
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07), new THREE.MeshBasicMaterial({ color: '#4da3ff', fog: false }));
        lamp.position.set(0, 2.08, 0);
        grp.add(body, helmet, visor, pack, stripe, lamp);
      } else {
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 3.6), white);
        body.position.y = 1.3;
        const cab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 1.6), new THREE.MeshStandardMaterial({ color: '#2b3038', metalness: 0.6, roughness: 0.3 }));
        cab.position.set(0, 2.1, -0.7);
        grp.add(body, cab);
        for (const [x, z] of [[-1.25, -1.3], [1.25, -1.3], [-1.25, 0], [1.25, 0], [-1.25, 1.3], [1.25, 1.3]]) {
          const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.35, 14), new THREE.MeshStandardMaterial({ color: '#3a3a3a', roughness: 0.9 }));
          wh.rotation.z = Math.PI / 2;
          wh.position.set(x, 0.5, z);
          grp.add(wh);
        }
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6), white);
        mast.position.set(0.7, 2.9, 0.9);
        grp.add(mast);
      }
      this.entityMeshes.set(en.id, grp);
      this.scene.add(grp);
    }
  }

  private buildPois() {
    for (const p of this.data.pois) {
      const base = this.v(p.e, p.n);
      if (p.kind === 'habitat') {
        const g = new THREE.Group();
        const white = new THREE.MeshStandardMaterial({ color: '#eeeeee', roughness: 0.6 });
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 5, 24), white);
        cyl.position.y = 2.5;
        const dome = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), white);
        dome.position.y = 5;
        const lock = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 4), white);
        lock.position.set(0, 1.5, -7);
        const light = new THREE.Mesh(new THREE.SphereGeometry(0.4), new THREE.MeshBasicMaterial({ color: '#3ce39a' }));
        light.position.set(0, 11.3, 0);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6), white);
        mast.position.y = 8;
        g.add(cyl, dome, lock, mast, light);
        g.position.copy(base);
        g.position.x += 20;
        g.position.z += 10;
        this.worldGroup.add(g);
      } else if (p.kind === 'sample' || p.kind === 'comms') {
        const g = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: '#cccccc' });
        for (let k = 0; k < 3; k++) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2), mat);
          leg.position.set(Math.cos((k * 2 * Math.PI) / 3) * 0.4, 1, Math.sin((k * 2 * Math.PI) / 3) * 0.4);
          leg.rotation.z = Math.cos((k * 2 * Math.PI) / 3) * 0.2;
          leg.rotation.x = -Math.sin((k * 2 * Math.PI) / 3) * 0.2;
          g.add(leg);
        }
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.25), new THREE.MeshBasicMaterial({ color: p.kind === 'sample' ? '#39d0ff' : '#3ce39a' }));
        beacon.position.y = 2.2;
        beacon.name = 'beacon';
        g.add(beacon);
        if (p.kind === 'comms') {
          const dish = new THREE.Mesh(new THREE.CircleGeometry(1.2, 20), new THREE.MeshStandardMaterial({ color: '#ddd', side: THREE.DoubleSide }));
          dish.position.y = 3;
          dish.rotation.x = -0.8;
          g.add(dish);
        }
        g.position.copy(base);
        g.position.x += 4;
        this.worldGroup.add(g);
      } else if (p.kind === 'cache') {
        const g = new THREE.Group();
        const crate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: '#d9d9d9', roughness: 0.5, metalness: 0.3 }));
        crate.position.y = 0.45;
        const band = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.16, 0.92), new THREE.MeshBasicMaterial({ color: '#ffb020' }));
        band.position.y = 0.62;
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.1, 12), new THREE.MeshStandardMaterial({ color: '#3ce39a', roughness: 0.4 }));
        tank.position.set(0.95, 0.55, 0);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4), new THREE.MeshStandardMaterial({ color: '#cccccc' }));
        pole.position.set(-0.6, 1.2, 0);
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16), new THREE.MeshBasicMaterial({ color: '#ffb020', fog: false }));
        beacon.position.set(-0.6, 2.45, 0);
        g.add(crate, band, tank, pole, beacon);
        g.position.copy(base);
        this.cacheBeacons.set(p.id, beacon);
        this.worldGroup.add(g);
      } else if (p.kind === 'shelter') {
        // undercut slab leaning against the butte face
        const slab = new THREE.Mesh(new THREE.BoxGeometry(18, 2.5, 12), new THREE.MeshStandardMaterial({ color: '#6a412c', roughness: 1, flatShading: true }));
        slab.position.copy(base).add(new THREE.Vector3(14, 6, 0));
        slab.rotation.z = 0.15;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 9, 14), slab.material);
        wall.position.copy(base).add(new THREE.Vector3(24, 3, 0));
        this.worldGroup.add(slab, wall);
      }
    }
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.rt.setSize(Math.round(w * pr), Math.round(h * pr));
    (this.lens.material as THREE.ShaderMaterial).uniforms.aspect.value = w / h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Multiply the optical zoom (scroll wheel). Returns the new target. */
  zoomBy(f: number) {
    this.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomTarget * f));
    if (this.zoomTarget < 1.04) this.zoomTarget = 1;
    return this.zoomTarget;
  }
  setZoom(z: number) {
    this.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    return this.zoomTarget;
  }
  /** Red rim pulse on the visor glass for alerts (0..1). */
  set alertFlash(v: number) {
    (this.lens.material as THREE.ShaderMaterial).uniforms.flash.value = v;
  }

  /** Map an undistorted screen point (px) to where it appears on the curved visor (px). */
  toVisor(x: number, y: number) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const a = w / h;
    const k = VISOR_K;
    const sx = ((x / w) * 2 - 1) * a;
    const sy = 1 - (y / h) * 2;
    const rs = Math.hypot(sx, sy);
    if (rs < 1e-6) return { x, y };
    // solve r (1 + k r^2) / (1 + k a^2) = rs  (Newton)
    const target = rs * (1 + k * a * a);
    let r = rs;
    for (let i = 0; i < 6; i++) r -= (r + k * r * r * r - target) / (1 + 3 * k * r * r);
    const f = r / rs;
    return { x: ((sx * f) / a + 1) * 0.5 * w, y: (1 - sy * f) * 0.5 * h };
  }

  /** Inverse of toVisor: a point on the curved visor (px) back to the undistorted image (px). */
  fromVisor(x: number, y: number) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const a = w / h;
    const k = VISOR_K;
    const vx = ((x / w) * 2 - 1) * a;
    const vy = 1 - (y / h) * 2;
    const f = (1 + k * (vx * vx + vy * vy)) / (1 + k * a * a);
    return { x: ((vx * f) / a + 1) * 0.5 * w, y: (1 - vy * f) * 0.5 * h };
  }

  /** pixels per metre at 1 m distance (for sizing outlines) */
  focalPx() {
    return this.container.clientHeight / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /**
   * What is under this visor pixel? Named things (crew, rover, drone, sites, tags) win when the
   * gaze is close to them; otherwise the view ray is marched over the terrain to find a boulder
   * or the patch of ground being looked at.
   */
  pick(px: number, py: number): Pick {
    const sim = this.sim;
    const g = this.guardian;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const focal = this.focalPx();
    type C = { type: Pick['type']; id: string; name: string; e: number; n: number; up: number; size: number };
    const cands: C[] = [];
    if (g) {
      for (const en of g.entities) cands.push({ type: 'entity', id: en.id, name: en.name, e: en.e, n: en.n, up: en.kind === 'teammate' ? 1.1 : 1.4, size: en.kind === 'teammate' ? 1.1 : 2.2 });
      for (const t of g.tags) {
        if (t.follow) continue;
        cands.push({ type: 'tag', id: String(t.id), name: t.label, e: t.e, n: t.n, up: t.up + 1.2, size: 0.8 });
      }
    }
    if (sim.drone.active) cands.push({ type: 'drone', id: 'drone', name: 'Scout drone', e: sim.drone.e, n: sim.drone.n, up: sim.drone.alt, size: 1.4 });
    for (const p of this.data.pois) {
      if (!sim.discovered.has(p.id) || p.kind === 'hazard') continue;
      const off = p.kind === 'habitat' ? [20, -10, 5, 8] : p.kind === 'shelter' ? [16, 0, 5, 9] : p.kind === 'cache' ? [0, 0, 0.8, 1.3] : [4, 0, 1.6, 1.6];
      cands.push({ type: 'poi', id: p.id, name: p.name, e: p.e + off[0], n: p.n + off[1], up: off[2], size: off[3] });
    }
    let best: (C & { d: number; dist: number }) | null = null;
    for (const c of cands) {
      const pr = this.project(c.e, c.n, c.up);
      if (!pr.visible || pr.dist > 2500) continue;
      const rad = Math.max(38, (c.size / Math.max(1, pr.dist)) * focal * 1.25);
      const d = Math.hypot(pr.x - px, pr.y - py) / rad;
      if (d < 1 && (!best || d < best.d)) best = { ...c, d, dist: pr.dist };
    }
    // view ray through the pixel (undo the visor curvature first)
    const u = this.fromVisor(px, py);
    const dir = new THREE.Vector3((u.x / w) * 2 - 1, 1 - (u.y / h) * 2, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const o = this.camera.position;
    const el = this.data.elevation;
    const minE = el.originE;
    const maxE = el.originE + el.cell * (el.width - 1);
    const maxN = el.originN;
    const minN = el.originN - el.cell * (el.height - 1);
    let hit: Pick | null = null;
    let prevT = 0;
    for (let t = 1; t < 3000; t += 0.5 + t * 0.03) {
      const x = o.x + dir.x * t;
      const yy = o.y + dir.y * t;
      const e = x;
      const n = -(o.z + dir.z * t);
      if (e < minE || e > maxE || n < minN || n > maxN) break;
      const gy = this.y(e, n);
      if (t < 260) {
        for (const ob of sim.obstacles.near(e, n, 0.6 + t * 0.012)) {
          if (yy < this.y(ob.e, ob.n) + ob.h + 0.3) {
            hit = { type: 'boulder', name: ob.kind === 'rubble' ? 'Rockfall debris' : ob.h <= 0.7 ? 'Low rock' : 'Boulder', e: ob.e, n: ob.n, up: ob.h * 0.5, dist: Math.hypot(ob.e - o.x, ob.n + o.z), size: Math.max(ob.r, ob.h * 0.6), obstacle: ob };
            break;
          }
        }
        if (hit) break;
      }
      if (yy <= gy) {
        // refine between the last two steps
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (o.y + dir.y * mid <= this.y(o.x + dir.x * mid, -(o.z + dir.z * mid))) hi = mid;
          else lo = mid;
        }
        hit = { type: 'ground', name: 'Ground', e: o.x + dir.x * hi, n: -(o.z + dir.z * hi), up: 0, dist: hi, size: Math.max(1.2, hi * 0.03) };
        break;
      }
      prevT = t;
    }
    if (best && (!hit || best.dist < hit.dist + 40)) return { type: best.type, id: best.id, name: best.name, e: best.e, n: best.n, up: best.up, dist: best.dist, size: best.size };
    if (hit) return hit;
    const p = sim.position();
    return { type: 'sky', name: 'Sky', e: p.e + dir.x * 1000, n: p.n - dir.z * 1000, up: 400, dist: 1000, size: 100 };
  }

  /** Still frame of the current view (for "take photo"). */
  snapshot(maxW = 480): string {
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = maxW;
    c.height = Math.round((maxW * src.height) / src.width);
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  /** Project world (e,n,up) to screen pixels. */
  project(e: number, n: number, up = 0): { x: number; y: number; visible: boolean; dist: number } {
    const v = this.v(e, n, up);
    const dist = v.distanceTo(this.camera.position);
    v.project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const o = this.toVisor(((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h);
    return { x: o.x, y: o.y, visible: v.z < 1 && v.z > -1, dist };
  }

  heading() {
    // compass heading (0 = north, clockwise), degrees
    return (((this.yaw * 180) / Math.PI) % 360 + 360) % 360;
  }

  update(dt: number) {
    const sim = this.sim;
    const p = sim.position();
    const moving = sim.isMoving();
    this.yaw = sim.lookYaw;
    this.time += dt;
    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 10);
    if (Math.abs(this.zoom - this.zoomTarget) < 1e-3) this.zoom = this.zoomTarget;
    const fov = (2 * Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / this.zoom) * 180) / Math.PI;
    if (Math.abs(fov - this.camera.fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (moving) this.bob += dt * 7;
    // body: jump height, fall to the ground, stumble jolt, marsquake shake
    const b = sim.body;
    const down = b.fallT > 0 ? Math.min(1, (4 - b.fallT) / 0.45, b.fallT / 1.1) : 0;
    const sh = Math.min(1, b.shake + this.quake);
    const jx = sh ? (Math.sin(this.time * 71) + Math.sin(this.time * 113)) * 0.035 * sh : 0;
    const jy = sh ? (Math.sin(this.time * 89) + Math.sin(this.time * 131)) * 0.03 * sh : 0;
    const stumble = b.stumbleT > 0 ? Math.sin(Math.min(1, (1.6 - b.stumbleT) / 0.5) * Math.PI) * 0.22 : 0;
    const eyeY = this.y(p.e, p.n) + EYE + b.alt - down * 1.25 - stumble * 0.5 + (moving && b.alt <= 0 ? Math.sin(this.bob) * 0.04 : 0) + jy;
    this.camera.position.set(p.e + jx, eyeY, -p.n);
    this.sky.position.copy(this.camera.position);
    const yaw = this.yaw;
    const pitch = this.pitch - down * 0.35 - stumble * 0.6 + jy * 0.4;
    const look = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camera.position.clone().add(look));
    this.roll += (down * 0.55 + stumble * 0.25 + jx * 0.6 - this.roll) * Math.min(1, dt * 12);
    if (Math.abs(this.roll) > 1e-4) this.camera.rotateZ(this.roll);

    // dust & visibility
    const dust = sim.agg().dust;
    const dm = this.dust.material as THREE.PointsMaterial;
    dm.opacity = Math.min(0.85, dust * 0.4);
    this.dust.position.set(p.e, this.y(p.e, p.n), -p.n);
    this.dust.rotation.y += dt * (0.3 + dust);
    this.fog.density = 0.00028 + dust * 0.004;
    (this.sky.material as THREE.ShaderMaterial).uniforms.dust.value = Math.min(0.9, dust * 0.4);
    this.fog.color.copy(this.skyColor).lerp(new THREE.Color('#b98a63'), Math.min(1, dust * 0.4));

    this.updateChevrons();
    this.updateHazardRings();
    // crew, rover, cache beacons
    if (this.guardian) {
      for (const en of this.guardian.entities) {
        const mesh = this.entityMeshes.get(en.id);
        if (!mesh) continue;
        mesh.position.set(en.e, this.y(en.e, en.n) + (en.moving ? Math.abs(Math.sin(this.time * 5)) * 0.04 : 0), -en.n);
        mesh.rotation.y = -en.heading;
      }
      for (const [id, beacon] of this.cacheBeacons) {
        const used = this.guardian.cachesUsed.has(id);
        (beacon.material as THREE.MeshBasicMaterial).color.set(used ? '#555555' : '#ffb020');
        beacon.scale.setScalar(used ? 0.7 : 1 + 0.3 * Math.sin(this.time * 4));
      }
    }

    // drone
    const dr = sim.drone;
    this.drone.visible = dr.active;
    if (dr.active) {
      this.drone.position.set(dr.e, this.y(dr.e, dr.n) + dr.alt, -dr.n);
      this.drone.rotation.y = -dr.heading;
      this.drone.children.forEach((c) => {
        if (c.name === 'rotor') c.rotation.y += dt * 40;
      });
      this.droneCam.position.copy(this.drone.position);
      const ahead = new THREE.Vector3(Math.sin(dr.heading) * 60, -this.drone.position.y + this.y(dr.e + Math.sin(dr.heading) * 60, dr.n + Math.cos(dr.heading) * 60), -Math.cos(dr.heading) * 60);
      this.droneCam.lookAt(this.drone.position.clone().add(ahead));
    }
  }

  /**
   * AR guide arrows: laid along the live guide path (A* around boulders, slopes and rubble),
   * flowing toward the destination. They follow whatever the navigator is routing to right now.
   */
  private updateChevrons() {
    const sim = this.sim;
    const guide = sim.guide;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const detour = !!sim.detour;
    const base = detour ? [1, 0.42, 0.84] : sim.goalOverride ? [1, 0.69, 0.13] : [0.22, 0.82, 1];
    const SPACING = 4.5;
    const MAXD = 190;
    let i = 0;
    if (sim.status === 'active' && guide.length > 1) {
      let next = 4.5 + ((this.time * 2.2) % SPACING); // flow toward the goal
      let acc = 0;
      outer: for (let k = 0; k < guide.length - 1; k++) {
        const [ae, an] = guide[k];
        const [be, bn] = guide[k + 1];
        const len = Math.hypot(be - ae, bn - an);
        if (len < 1e-3) continue;
        while (next <= acc + len) {
          if (i >= 72 || next > MAXD) break outer;
          const t = (next - acc) / len;
          const e = ae + (be - ae) * t;
          const n = an + (bn - an) * t;
          q.setFromAxisAngle(up, -Math.atan2(be - ae, bn - an));
          const s = 0.95 + Math.min(1.6, next / 60);
          sc.set(s, 1, s);
          m.compose(this.v(e, n, 0.14), q, sc);
          this.chevrons.setMatrixAt(i, m);
          const fade = Math.min(1, (next - 4) / 4) * (1 - Math.pow(next / MAXD, 2)) * (0.75 + 0.25 * Math.sin(this.time * 5 - next * 0.35));
          col.setRGB(base[0] * fade, base[1] * fade, base[2] * fade);
          this.chevrons.setColorAt(i, col);
          i++;
          next += SPACING;
        }
        acc += len;
      }
    }
    this.chevrons.count = i;
    this.chevrons.instanceMatrix.needsUpdate = true;
    if (this.chevrons.instanceColor) this.chevrons.instanceColor.needsUpdate = true;
    // destination ring
    const wp = sim.status === 'active' ? sim.nextWaypoint() : null;
    this.goalRing.visible = !!wp && wp.dist < 400 && wp.dist > 14;
    if (wp) {
      this.goalRing.position.copy(this.v(wp.e, wp.n, 0.2));
      const s = 1.4 + 0.35 * Math.sin(this.time * 3) + Math.min(3, wp.dist / 60);
      this.goalRing.scale.set(s, 1, s);
      (this.goalRing.material as THREE.MeshBasicMaterial).color.setRGB(base[0], base[1], base[2]);
    }
  }

  private ringsBuilt = new Set<string>();
  private updateHazardRings() {
    for (const p of this.data.pois) {
      if (p.kind !== 'hazard' || !this.sim.discovered.has(p.id) || this.ringsBuilt.has(p.id)) continue;
      this.ringsBuilt.add(p.id);
      const r = p.radius ?? 100;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        pts.push(this.v(p.e + Math.cos(a) * r, p.n + Math.sin(a) * r, 0.4));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#ffb020', transparent: true, opacity: 0.9, fog: false }));
      this.hazardRings.add(line);
    }
  }

  render(pipEl: HTMLElement | null) {
    const r = this.renderer;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (this.rt.width < 8) this.resize();
    r.setScissorTest(false);
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.setViewport(0, 0, w, h);
    (this.lens.material as THREE.ShaderMaterial).uniforms.time.value = this.time;
    r.render(this.lensScene, this.lensCam);
    if (pipEl && this.sim.drone.active) {
      this.pipFrame = (this.pipFrame + 1) % 3;
      if (this.pipFrame !== 0) return;
      const PW = 320;
      const PH = 180;
      if (!this.pipTarget) this.pipTarget = new THREE.WebGLRenderTarget(PW, PH);
      this.droneCam.aspect = PW / PH;
      this.droneCam.updateProjectionMatrix();
      const skyPos = this.sky.position.clone();
      this.sky.position.copy(this.droneCam.position);
      this.drone.visible = false;
      r.setRenderTarget(this.pipTarget);
      r.render(this.scene, this.droneCam);
      r.setRenderTarget(null);
      this.drone.visible = true;
      this.sky.position.copy(skyPos);
      const buf = new Uint8Array(PW * PH * 4);
      r.readRenderTargetPixels(this.pipTarget, 0, 0, PW, PH, buf);
      let cv = pipEl.querySelector('canvas');
      if (!cv) {
        cv = document.createElement('canvas');
        cv.width = PW;
        cv.height = PH;
        cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        pipEl.appendChild(cv);
      }
      const ctx = cv.getContext('2d')!;
      const img = ctx.createImageData(PW, PH);
      for (let y = 0; y < PH; y++) img.data.set(buf.subarray((PH - 1 - y) * PW * 4, (PH - y) * PW * 4), y * PW * 4);
      ctx.putImageData(img, 0, 0);
      // overlay telemetry
      const d = this.sim.drone;
      ctx.fillStyle = 'rgba(207,246,255,0.95)';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillText(`ALT ${d.alt.toFixed(0)} m · HDG ${(((d.heading * 180) / Math.PI + 360) % 360).toFixed(0)}° · ${d.mode.toUpperCase()}`, 6, 14);
      ctx.fillText(`DRONE BATT ${d.battery.toFixed(0)}%`, 6, PH - 6);
      ctx.strokeStyle = 'rgba(57,208,255,0.8)';
      ctx.strokeRect(PW / 2 - 12, PH / 2 - 8, 24, 16);
    } else if (pipEl) {
      const cv = pipEl.querySelector('canvas');
      if (cv) cv.remove();
    }
  }
}
