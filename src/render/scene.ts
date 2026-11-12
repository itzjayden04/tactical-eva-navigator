/**
 * 3D WORLD (Three.js). Reads simulation state every frame; never mutates it.
 */
import * as THREE from 'three';
import groundUrl from '../assets/ground.jpg';
import type { DataBundle } from '../data/types';
import { sample, slopeDeg } from '../core/grid';
import type { Sim } from '../core/sim';
import { fbm } from '../data/mockJezero';

const EYE = 1.75;

export type ViewMode = 'vr' | 'ar';

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
  mode: ViewMode = 'vr';
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

  constructor(private container: HTMLElement, private data: DataBundle, private sim: Sim) {
    this.ref = -2600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(70, container.clientWidth / container.clientHeight, 0.1, 12000);
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
    const chevMat = new THREE.MeshBasicMaterial({ color: '#39d0ff', transparent: true, opacity: 0.75, depthWrite: false, fog: false });
    this.chevrons = new THREE.InstancedMesh(chevGeo, chevMat, 40);
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
          place(smp.e + Math.cos(a) * d, smp.n + Math.sin(a) * d, size);
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
      place(e, n, 0.4 + Math.pow(r(), 2) * 2.5 * (0.5 + rock));
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    this.worldGroup.add(mesh);
  }

  private buildTrack() {
    // marker flags every 40 m
    const poles: THREE.Vector3[] = [];
    for (const g of this.sim.world.edges.values()) {
      for (let s = 20; s < g.length - 10; s += 40) {
        const pt = this.sim.world.pointOnLeg({ edgeId: g.edge.id, forward: true }, s);
        poles.push(this.v(pt.e + 1.6, pt.n));
      }
    }
    const poleGeo = new THREE.CylinderGeometry(0.025, 0.025, 1.4, 5);
    poleGeo.translate(0, 0.7, 0);
    const pm = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: '#dcdcdc' }), poles.length);
    const flagGeo = new THREE.PlaneGeometry(0.35, 0.22);
    flagGeo.translate(0.18, 1.28, 0);
    const fm = new THREE.InstancedMesh(flagGeo, new THREE.MeshBasicMaterial({ color: '#ff8a3d', side: THREE.DoubleSide }), poles.length);
    const m = new THREE.Matrix4();
    poles.forEach((p, i) => {
      m.makeTranslation(p.x, p.y, p.z);
      pm.setMatrixAt(i, m);
      fm.setMatrixAt(i, m);
    });
    this.worldGroup.add(pm, fm);
    // faint trail line
    for (const g of this.sim.world.edges.values()) {
      const pts = g.samples.map((s) => this.v(s.e, s.n, 0.06));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#e9c19a', transparent: true, opacity: 0.35 }));
      this.worldGroup.add(line);
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

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.worldGroup.visible = mode === 'vr';
    this.sky.visible = mode === 'vr';
    this.dust.visible = mode === 'vr';
    this.scene.fog = mode === 'vr' ? this.fog : null;
    this.renderer.setClearColor(0x000000, mode === 'vr' ? 1 : 0);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Project world (e,n,up) to screen pixels. */
  project(e: number, n: number, up = 0): { x: number; y: number; visible: boolean; dist: number } {
    const v = this.v(e, n, up);
    const dist = v.distanceTo(this.camera.position);
    v.project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, visible: v.z < 1 && v.z > -1, dist };
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
    if (moving) this.bob += dt * 7;
    const eyeY = this.y(p.e, p.n) + EYE + (moving ? Math.sin(this.bob) * 0.04 : 0);
    this.camera.position.set(p.e, eyeY, -p.n);
    this.sky.position.copy(this.camera.position);
    const yaw = this.yaw;
    const look = new THREE.Vector3(Math.sin(yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(yaw) * Math.cos(this.pitch));
    this.camera.lookAt(this.camera.position.clone().add(look));

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

  private updateChevrons() {
    const sim = this.sim;
    const plan = sim.plan;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(1.1, 1, 1.1);
    let i = 0;
    if (plan && sim.status === 'active') {
      let acc = 0;
      const start = sim.pos.leg ? sim.pos.s : 0;
      outer: for (let li = 0; li < plan.route.length; li++) {
        const leg = plan.route[li];
        const len = sim.world.legLength(leg);
        for (let s = li === 0 ? start + 6 : 6; s < len; s += 7) {
          if (i >= 40 || acc > 200) break outer;
          const a = sim.world.pointOnLeg(leg, s);
          const b = sim.world.pointOnLeg(leg, Math.min(len, s + 2));
          const yaw = Math.atan2(b.e - a.e, b.n - a.n);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
          m.compose(this.v(a.e, a.n, 0.12), q, sc);
          this.chevrons.setMatrixAt(i++, m);
          acc += 7;
        }
      }
    }
    this.chevrons.count = i;
    this.chevrons.instanceMatrix.needsUpdate = true;
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
    r.setViewport(0, 0, w, h);
    r.setScissorTest(false);
    r.render(this.scene, this.camera);
    if (pipEl && this.sim.drone.active) {
      this.pipFrame = (this.pipFrame + 1) % 3;
      if (this.pipFrame !== 0) return;
      const ar = this.mode === 'ar';
      if (ar) {
        this.worldGroup.visible = true;
        this.sky.visible = true;
        this.scene.fog = this.fog;
      }
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
      if (ar) {
        this.worldGroup.visible = false;
        this.sky.visible = false;
        this.scene.fog = null;
      }
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
