import * as THREE from 'three/webgpu';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import {
  color, float, vec2, vec3, vec4, mix, smoothstep, screenUV, pass, uniform,
  Fn, Loop, dot, exp, length, normalize, select, time, cameraPosition,
  mx_noise_float,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createTerrain, terrainHeight } from './terrain.js';
import { createForest } from './trees.js';
import { createGrass } from './grass.js';
import { createFlowers } from './flowers.js';

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// Hazy bright sky gradient + matching global haze.
const horizon = color(0xe9efee);
const zenith = color(0xa9c3d2);
// screenUV.y runs top -> bottom, so zenith first
scene.backgroundNode = mix(zenith, horizon, smoothstep(0.2, 0.7, screenUV.y));
scene.fog = new THREE.FogExp2(0xd2dad2, 0.012);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);
const camX = 1, camZ = 15;
camera.position.set(camX, terrainHeight(camX, camZ) + 1.7, camZ);
camera.lookAt(-2, terrainHeight(-2, -4) + 3.2, -4);

// Backlit sun pushing through the mist.
const sun = new THREE.DirectionalLight(0xffe9c4, 3.8);
sun.position.set(-34, 26, -32);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -55;
sun.shadow.camera.right = 55;
sun.shadow.camera.top = 55;
sun.shadow.camera.bottom = -55;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
scene.add(sun);

scene.add(new THREE.HemisphereLight(0xd2ddd8, 0x4a5230, 0.85));

scene.add(createTerrain());
scene.add(createForest());
scene.add(createGrass());
scene.add(createFlowers());

// ---------------- post processing ----------------

const postProcessing = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode('output');
// normalized linear depth (0 at near, 1 at far) — handles reversed-z for us
const sceneLinearDepth = scenePass.getLinearDepthNode();

// camera uniforms for depth -> world reconstruction
const uNear = uniform(camera.near);
const uFar = uniform(camera.far);
const uTanY = uniform(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
const uTanX = uniform(uTanY.value * camera.aspect);
const uCamWorld = uniform(camera.matrixWorld); // same instance, stays in sync
const sunDir = sun.position.clone().normalize();
const uSunDir = uniform(sunDir.clone());

// ---- volumetric ground mist (analytic height fog, noise modulated) ----
const MIST_BASE = -6.5;     // height where mist is thickest
const MIST_FALLOFF = 0.5;   // vertical density falloff
const MIST_DENSITY = 0.06;

const mistedScene = Fn(() => {
  const suv = screenUV;

  // view ray through this pixel
  const ndcX = suv.x.mul(2).sub(1);
  const ndcY = float(1).sub(suv.y).mul(2).sub(1);
  const viewVec = vec3(ndcX.mul(uTanX), ndcY.mul(uTanY), -1);

  // linear depth -> distance along the ray
  const zMag = uNear.add(uFar.sub(uNear).mul(sceneLinearDepth.x));
  const dist = zMag.mul(length(viewVec)).min(260);
  const rayW = normalize(uCamWorld.mul(vec4(normalize(viewVec), 0)).xyz);

  // analytic integral of density d0 * exp(-(y - base) * falloff) along the ray
  const dy = rayW.y;
  const dyc = select(dy.abs().lessThan(0.002), float(0.002).mul(dy.sign().add(0.5).sign()), dy);
  const camFactor = exp(cameraPosition.y.sub(MIST_BASE).mul(-MIST_FALLOFF));
  const fogAmount = float(MIST_DENSITY / MIST_FALLOFF)
    .mul(camFactor)
    .mul(float(1).sub(exp(dyc.mul(dist).mul(-MIST_FALLOFF))))
    .div(dyc);

  // drifting noise so the mist has shape and motion
  const mid = cameraPosition.add(rayW.mul(dist.min(90).mul(0.5)));
  const n = mx_noise_float(vec3(
    mid.x.mul(0.045).add(time.mul(0.05)),
    mid.y.mul(0.12),
    mid.z.mul(0.045).sub(time.mul(0.03)),
  )).mul(0.5).add(0.5);
  const mistAmount = float(1).sub(exp(fogAmount.mul(n.mul(1.2).add(0.35)).negate())).saturate();

  // warm the mist toward the sun (cheap forward scattering)
  const glow = dot(rayW, uSunDir).max(0).pow(5);
  const mistCol = mix(color(0xdde5e1), color(0xffeccd), glow.mul(0.75));

  return mix(sceneColor.rgb, mistCol, mistAmount);
})();

// ---- god rays: radial blur of bright pixels toward the sun ----
const RAY_SAMPLES = 44;
const uSunScreen = uniform(new THREE.Vector2(0.5, 0.4));
const uRayStrength = uniform(0);

const godRays = Fn(() => {
  const suv = screenUV.toVar();
  const delta = uSunScreen.sub(screenUV).mul(0.9 / RAY_SAMPLES);
  const decay = float(1).toVar();
  const acc = vec3(0).toVar();
  Loop(RAY_SAMPLES, () => {
    suv.addAssign(delta);
    const c = sceneColor.sample(suv).rgb;
    const lum = dot(c, vec3(0.299, 0.587, 0.114));
    acc.addAssign(c.mul(smoothstep(0.55, 1.1, lum)).mul(decay));
    decay.mulAssign(0.955);
  });
  return acc.div(RAY_SAMPLES).mul(color(0xffe2b0)).mul(uRayStrength);
})();

const bloomPass = bloom(sceneColor, 0.3, 0.5, 0.8);
postProcessing.outputNode = vec4(mistedScene.add(bloomPass.rgb).add(godRays), 1);

// ---------------- FPS controls ----------------

const controls = new PointerLockControls(camera, renderer.domElement);

const overlay = document.createElement('div');
overlay.style.cssText = `
  position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
  background:rgba(20,28,24,0.25); color:#eef3ee; cursor:pointer; user-select:none;
  font:500 18px/1.6 system-ui, sans-serif; text-align:center; letter-spacing:0.02em;`;
overlay.innerHTML = '<div>Click to walk<br><span style="font-size:14px;opacity:0.8">WASD move &middot; Shift run &middot; mouse look &middot; Esc release</span></div>';
document.body.appendChild(overlay);

overlay.addEventListener('click', () => controls.lock());
controls.addEventListener('lock', () => { overlay.style.display = 'none'; });
controls.addEventListener('unlock', () => { overlay.style.display = 'flex'; });

const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

let velF = 0, velR = 0;
const EYE = 1.7;

// ---------------- frame loop ----------------

const camDir = new THREE.Vector3();
const proj = new THREE.Vector3();
const clock = new THREE.Clock();

function updateSun() {
  // project a point far along the sun direction into screen space
  proj.copy(camera.position).addScaledVector(sunDir, 200).project(camera);
  uSunScreen.value.set(proj.x * 0.5 + 0.5, 0.5 - proj.y * 0.5);

  // fade the rays out as the sun leaves the view
  camera.getWorldDirection(camDir);
  uRayStrength.value = THREE.MathUtils.smoothstep(camDir.dot(sunDir), 0.05, 0.45) * 3.2;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  uTanX.value = uTanY.value * camera.aspect;
  renderer.setSize(window.innerWidth, window.innerHeight);
});

if (import.meta.env.DEV) window.__debug = { camera, sunDir };

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (controls.isLocked) {
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 10 : 4.5;
    const tF = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const tR = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const k = Math.min(1, dt * 9);
    velF += (tF * speed - velF) * k;
    velR += (tR * speed - velR) * k;
    controls.moveForward(velF * dt);
    controls.moveRight(velR * dt);
  }
  // stick to the ground
  camera.position.y = terrainHeight(camera.position.x, camera.position.z) + EYE;

  updateSun();
  postProcessing.render();
});
