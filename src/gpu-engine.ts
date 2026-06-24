import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/addons/misc/GPUComputationRenderer.js";
import {
  MAIN_BODY_COUNT,
  PARTICLE_COUNT,
  TEXTURE_SIZE,
  fullscreenVertexShader,
  gridFragmentShader,
  gridVertexShader,
  positionShader,
  trailCompositeShader,
  trailFadeShader,
  velocityShader,
} from "./gpu-shaders";

export type Vec2 = { x: number; y: number };
export type CameraState = { x: number; y: number; zoom: number };
export type CreationPreview = { position: Vec2; radius: number; vectorEnd?: Vec2 };

export type BodySnapshot = {
  id: number;
  name: string;
  position: Vec2;
  velocity: Vec2;
  mass: number;
  radius: number;
  /** Поверхностная плотность (mass / radius^2): отличает планету от чёрной дыры. */
  density: number;
  hue: number;
  isFragment: boolean;
};

type Injection = { slot: number; position: Vec2; velocity: Vec2; radius: number; customMass?: number };
type Flash = { glow: THREE.Mesh; ring: THREE.Mesh; active: boolean; start: number; x: number; y: number; strength: number };

const MASS_DENSITY = 0.15;
// Вспышка столкновения: размер пула и длительность (в симуляционном времени).
const FLASH_POOL_SIZE = 16;
const FLASH_DURATION = 0.7;
// Сетка пространства-времени: количество линий и сила искривления. Сетка
// привязана к камере (см. u_gridOffset), поэтому охвата хватает на любой панораме.
const GRID_COUNT = 80;
const GRID_WARP = 22.0;
// Доля следа, сохраняемая каждый кадр: ниже — короче хвосты, выше — длиннее.
const TRAIL_FADE = 0.95;
const TRAIL_INTENSITY = 1.0;
// Полуширина линии следа в мировых единицах (узкая линия, а не диск тела).
const TRAIL_LINE_WIDTH = 2.0;

export class GPUEngine {
  readonly capacity = PARTICLE_COUNT;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private readonly gpuCompute: GPUComputationRenderer;
  private readonly positionVariable: Variable;
  private readonly velocityVariable: Variable;
  private readonly particleMaterial: THREE.MeshBasicMaterial;
  private particleUniforms: Record<string, THREE.IUniform> | null = null;
  private readonly preview: THREE.Mesh;
  private readonly previewRing: THREE.Mesh;
  private readonly vectorLine: THREE.Line;
  private readonly vectorArrow: THREE.Mesh;
  private readonly positionReadback = new Float32Array(PARTICLE_COUNT * 4);
  private readonly velocityReadback = new Float32Array(PARTICLE_COUNT * 4);
  private readonly occupiedMain = new Uint8Array(MAIN_BODY_COUNT);
  private readonly pendingDeletionMain = new Uint8Array(MAIN_BODY_COUNT);
  private readonly injectionQueue: Injection[] = [];
  private readonly deletionQueue: number[] = [];
  private readonly trailScene = new THREE.Scene();
  private readonly trailComposite = new THREE.Scene();
  private readonly flashScene = new THREE.Scene();
  private readonly flashes: Flash[] = [];
  private readonly gridScene = new THREE.Scene();
  private gridUniforms: Record<string, THREE.IUniform> | null = null;
  private readonly fullscreenCamera = new THREE.Camera();
  private readonly trailFadeUniforms: Record<string, THREE.IUniform>;
  private readonly trailCompositeUniforms: Record<string, THREE.IUniform>;
  private trailRead: THREE.WebGLRenderTarget;
  private trailWrite: THREE.WebGLRenderTarget;
  private readonly previousCamera: CameraState = { x: 0, y: 0, zoom: 1 };
  private readonly clearColorCache = new THREE.Color();
  private hasPreviousCamera = false;
  private width = 1;
  private height = 1;
  private elapsed = 0;
  private pixelRatio = 1;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    if (!context) throw new Error("Для GPU-физики требуется WebGL2.");
    if (!context.getExtension("EXT_color_buffer_float")) {
      throw new Error("Видеокарта не поддерживает float render targets.");
    }

    this.renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
    this.renderer.setClearColor(0x090a0f, 0.42);
    this.camera.position.set(0, 0, 10);

    this.gpuCompute = new GPUComputationRenderer(TEXTURE_SIZE, TEXTURE_SIZE, this.renderer);
    const initialPosition = this.gpuCompute.createTexture();
    const initialVelocity = this.gpuCompute.createTexture();
    this.positionVariable = this.gpuCompute.addVariable("texturePosition", positionShader, initialPosition);
    this.velocityVariable = this.gpuCompute.addVariable("textureVelocity", velocityShader, initialVelocity);
    this.gpuCompute.setVariableDependencies(this.positionVariable, [this.positionVariable, this.velocityVariable]);
    this.gpuCompute.setVariableDependencies(this.velocityVariable, [this.positionVariable, this.velocityVariable]);
    this.addComputeUniforms(this.positionVariable);
    this.addComputeUniforms(this.velocityVariable);
    const computeError = this.gpuCompute.init();
    if (computeError) throw new Error(`GPU compute initialization failed: ${computeError}`);

    const geometry = this.createParticleGeometry();
    this.particleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.particleMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.texturePosition = { value: this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture };
      shader.uniforms.textureVelocity = { value: this.gpuCompute.getCurrentRenderTarget(this.velocityVariable).texture };
      shader.uniforms.uTrailMode = { value: 0 };
      shader.uniforms.uTrailWidth = { value: TRAIL_LINE_WIDTH };
      shader.uniforms.uSelectedSlot = { value: -1 };
      shader.uniforms.uTime = { value: 0 };
      this.particleUniforms = shader.uniforms;
      shader.vertexShader = `
        uniform sampler2D texturePosition;
        uniform sampler2D textureVelocity;
        uniform float uTrailMode;
        uniform float uTrailWidth;
        uniform float uSelectedSlot;
        attribute vec2 reference;
        attribute float slotIndex;
        varying float vBodyAlpha;
        varying vec3 vBodyColor;
        varying vec2 vBodyLocal;
        varying float vSelected;
        varying float vDensity;
        varying float vGlowScale;
        varying float vSeed;
        // Цвет «по температуре»: холодный тёмно-красный -> оранжевый -> тёпло-белый
        // -> горячий голубовато-белый (как излучение чёрного тела).
        vec3 heatColor(float t) {
          vec3 c1 = vec3(0.55, 0.11, 0.06);
          vec3 c2 = vec3(1.0, 0.36, 0.12);
          vec3 c3 = vec3(1.0, 0.83, 0.52);
          vec3 c4 = vec3(0.74, 0.87, 1.0);
          if (t < 0.34) return mix(c1, c2, t / 0.34);
          if (t < 0.67) return mix(c2, c3, (t - 0.34) / 0.33);
          return mix(c3, c4, (t - 0.67) / 0.33);
        }
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `
          vec4 gpuPosition = texture2D(texturePosition, reference);
          vec4 gpuVelocity = texture2D(textureVelocity, reference);
          float bodyActive = step(0.00001, gpuPosition.z);
          // Внешний вид выбирается по ПЛОТНОСТИ (mass / r^2), а не по массе: газовый
          // гигант -> планета -> звезда -> белый карлик -> нейтронная звезда -> чёрная
          // дыра. Пороги band'ов совпадают с DENSITY_BANDS в object-types.ts.
          float density = gpuPosition.z / max(gpuPosition.w * gpuPosition.w, 1e-6);
          vDensity = density;
          // Постоянный «случайный» сид на тело: газовые гиганты/планеты не похожи,
          // и им же решается, есть ли у газового гиганта кольца.
          float seed = fract(sin(slotIndex * 12.9898) * 43758.5453);
          vSeed = seed;
          // Увеличенный квадрат: светящиеся тела -> корона; часть газовых гигантов -> кольца.
          float glowScale = 1.0;
          if (density >= 45.0 && density < 120.0) glowScale = 2.0;        // нейтронная звезда
          else if (density >= 4.0 && density < 45.0) glowScale = 1.55;    // белый карлик
          else if (density >= 0.3 && density < 4.0) glowScale = 1.7;      // звезда
          else if (density < 0.09 && seed > 0.5) glowScale = 2.2;         // газовый гигант с кольцами
          // В режиме следа — тонкая точка в центре (без короны и без увеличения).
          vGlowScale = uTrailMode > 0.5 ? 1.0 : glowScale;
          float renderRadius = uTrailMode > 0.5 ? min(gpuPosition.w, uTrailWidth) : gpuPosition.w * glowScale;
          renderRadius *= bodyActive;
          vec3 transformed = vec3(
            gpuPosition.x + position.x * renderRadius,
            -gpuPosition.y + position.y * renderRadius,
            position.z
          );
          if (bodyActive < 0.5) transformed = vec3(1000000.0);
          // «Температура» растёт с массой (gpuPosition.z) и скоростью.
          float bodyHeat = 1.0 - exp(-(gpuPosition.z * 0.012 + length(gpuVelocity.xy) * 0.005));
          vBodyColor = heatColor(bodyHeat);
          float fragmentAlpha = gpuVelocity.z > 0.0 ? smoothstep(0.0, 3.0, gpuVelocity.z) : 1.0;
          vBodyAlpha = bodyActive * fragmentAlpha;
          vBodyLocal = position.xy;
          // Подсветка только в экранном проходе (в след — нет).
          vSelected = (uTrailMode < 0.5 && abs(slotIndex - uSelectedSlot) < 0.5) ? 1.0 : 0.0;
        `,
      );
      shader.fragmentShader = `
        uniform float uTime;
        varying float vBodyAlpha;
        varying vec3 vBodyColor;
        varying vec2 vBodyLocal;
        varying float vSelected;
        varying float vDensity;
        varying float vGlowScale;
        varying float vSeed;
        // Дешёвый value-noise для шероховатой поверхности каменистых тел и пятен.
        float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "vec4 diffuseColor = vec4( diffuse, opacity );",
        `
          float r = length(vBodyLocal);
          if (r > 1.0) discard;
          // Тело занимает внутреннюю часть квадрата (до surface); за ним — корона.
          // Для несветящихся тел vGlowScale = 1 -> surface = 1 (поведение как раньше).
          float surface = 1.0 / vGlowScale;
          vec2 local = vBodyLocal / surface;
          float bodyRadiusSq = dot(local, local);
          float bodyR = sqrt(bodyRadiusSq);
          float bodyEdge = 1.0 - smoothstep(0.68, 1.0, bodyRadiusSq);
          float bodyHighlight = 1.0 - smoothstep(0.0, 0.46, length(local + vec2(0.28, 0.30)));
          vec3 shadedBodyColor = vBodyColor + bodyHighlight * 0.42;
          // Базовый вид — каменистое тело (планета/астероид). Дальше внешность зависит
          // от ПЛОТНОСТИ: те же пороги, что DENSITY_BANDS в object-types.ts.
          vec4 diffuseColor = vec4(shadedBodyColor, vBodyAlpha * bodyEdge);

          if (vDensity >= 120.0) {
            // Чёрная дыра: тень сингулярности + вращающийся диск + фотонное кольцо.
            if (bodyR < 0.33) {
              diffuseColor = vec4(0.01, 0.01, 0.02, vBodyAlpha);
            } else {
              float ang = atan(local.y, local.x);
              float swirl = 0.7 + 0.3 * sin(ang * 2.0 - uTime * 2.4);
              float diskFactor = smoothstep(0.33, 0.47, bodyR) * (1.0 - smoothstep(0.47, 1.0, bodyR));
              vec3 diskColor = mix(vec3(0.7, 0.2, 1.0), vec3(1.0, 0.45, 0.1), smoothstep(0.33, 1.0, bodyR));
              vec3 col = diskColor * 1.8 * swirl;
              float alpha = diskFactor * 0.95;
              // Фотонное кольцо: свет, искривлённый гравитацией у горизонта (линзирование).
              float photon = smoothstep(0.39, 0.42, bodyR) * (1.0 - smoothstep(0.42, 0.46, bodyR));
              col += vec3(0.75, 0.85, 1.0) * photon * 1.5;
              alpha = max(alpha, photon * 0.95);
              diffuseColor = vec4(col, alpha * vBodyAlpha);
            }
          } else if (vDensity >= 45.0) {
            // Нейтронная звезда (пульсар): ослепительное ядро с быстрым пульсом.
            float pulse = 0.85 + 0.15 * sin(uTime * 7.0 + vSeed * 6.2831);
            float core = 1.0 - smoothstep(0.0, 1.0, bodyR);
            vec3 nsColor = mix(vec3(0.62, 0.86, 1.0), vec3(1.0), core * core);
            diffuseColor = vec4(nsColor * (1.4 + core * 0.8) * pulse, bodyEdge * vBodyAlpha);
          } else if (vDensity >= 4.0) {
            // Белый карлик: маленькое плотное бело-голубое ядро.
            float core = 1.0 - smoothstep(0.0, 1.0, bodyR);
            vec3 wdColor = mix(vec3(0.85, 0.9, 1.0), vec3(1.0), core);
            diffuseColor = vec4(wdColor * (1.15 + core * 0.5), bodyEdge * vBodyAlpha);
          } else if (vDensity >= 0.3) {
            // Звезда: яркое горячее ядро с медленной пульсацией.
            float pulse = 0.94 + 0.06 * sin(uTime * 1.3 + vSeed * 6.2831);
            float core = 1.0 - smoothstep(0.0, 0.95, bodyR);
            vec3 starColor = mix(vBodyColor, vec3(1.0, 0.95, 0.82), core * 0.6);
            diffuseColor = vec4(starColor * (1.25 + core * 0.6) * pulse, bodyEdge * vBodyAlpha);
          } else if (vDensity < 0.09) {
            // Газовый гигант: полосы + дрейфующее пятно-шторм + лёгкая турбулентность.
            float turb = 0.15 * vnoise(local * 4.0 + vec2(uTime * 0.2, 0.0));
            float bands = 0.5 + 0.5 * sin(local.y * (7.0 + vSeed * 5.0) + vSeed * 6.2831 + turb * 6.0);
            vec3 ggBase = mix(shadedBodyColor, vec3(0.85, 0.72, 0.55), 0.45);
            ggBase *= mix(0.8, 1.12, bands);
            // Большое пятно-шторм дрейфует по долготе со временем.
            float drift = uTime * 0.15 + vSeed * 6.2831;
            vec2 spot = (local - vec2(0.3 * cos(drift), -0.18 + (vSeed - 0.5) * 0.3)) * vec2(1.0, 1.7);
            float storm = 1.0 - smoothstep(0.0, 0.32, length(spot));
            ggBase = mix(ggBase, vec3(0.78, 0.34, 0.24), storm * 0.55);
            diffuseColor = vec4(ggBase, bodyEdge * vBodyAlpha * 0.92);
          } else {
            // Каменистое тело (планета/астероид): шероховатая «каменная» поверхность.
            float n = vnoise(local * 3.5 + vSeed * 41.0);
            float n2 = vnoise(local * 8.0 - vSeed * 17.0);
            vec3 rockColor = shadedBodyColor * (0.82 + 0.30 * n + 0.08 * n2);
            diffuseColor = vec4(rockColor, bodyEdge * vBodyAlpha);
          }

          // Корона/ореол светящихся тел: мягкое свечение ЗА поверхностью тела
          // (между surface и краем квадрата), цвет — по типу. Только для звёзд и
          // компактных остатков; у газовых гигантов увеличенный квадрат идёт под кольца.
          if (vGlowScale > 1.001 && r > surface && vDensity >= 0.3) {
            vec3 glowColor =
              vDensity >= 45.0 ? vec3(0.55, 0.82, 1.0) :   // нейтронная звезда — голубая
              vDensity >= 4.0  ? vec3(0.78, 0.86, 1.0) :   // белый карлик — холодно-белый
                                 vec3(1.0, 0.82, 0.5);      // звезда — тёплая золотистая
            float halo = 1.0 - smoothstep(surface, 1.0, r);
            halo *= halo;
            diffuseColor.rgb += glowColor * halo * 0.9;
            diffuseColor.a = max(diffuseColor.a, halo * 0.8 * vBodyAlpha);
          }

          // Кольца газового гиганта (есть не у всех — по сиду): наклонный эллипс с полосами.
          if (vGlowScale > 1.001 && vDensity < 0.09) {
            float rr = length(vec2(local.x, local.y / 0.35));
            float ringMask = smoothstep(1.25, 1.33, rr) * (1.0 - smoothstep(1.9, 2.0, rr));
            ringMask *= 0.5 + 0.5 * sin(rr * 24.0);        // тонкие полосы колец
            ringMask *= 0.6 + 0.4 * sin(rr * 7.0 + 1.5);   // широкие зоны и щель (тип Кассини)
            ringMask = clamp(ringMask, 0.0, 1.0);
            // Передняя дуга (local.y < 0) рисуется поверх планеты; задняя — за телом, скрыта.
            float ringVisible = (length(local) > 1.0 || local.y < 0.0) ? 1.0 : 0.0;
            ringMask *= ringVisible;
            vec3 ringColor = vec3(0.82, 0.74, 0.6);
            diffuseColor.rgb = mix(diffuseColor.rgb, ringColor, ringMask * 0.85);
            diffuseColor.a = max(diffuseColor.a, ringMask * 0.85 * vBodyAlpha);
          }

          if (vSelected > 0.5) {
            // Яркое кольцо по краю выбранного тела — поверх любого типа.
            float ring = smoothstep(0.52, 0.7, bodyRadiusSq);
            diffuseColor.rgb = mix(diffuseColor.rgb + 0.12, vec3(1.0), ring * 0.85);
            diffuseColor.a = max(diffuseColor.a, ring * vBodyAlpha);
          }
        `,
      );
    };
    this.particleMaterial.customProgramCacheKey = () => "gpgpu-particles-v8";
    const particles = new THREE.Mesh(geometry, this.particleMaterial);
    particles.frustumCulled = false;
    this.scene.add(particles);

    this.preview = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({ color: 0x69c9f4, transparent: true, opacity: 0.62, depthTest: false }),
    );
    this.previewRing = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1.04, 40),
      new THREE.MeshBasicMaterial({ color: 0xc1ebff, transparent: true, opacity: 0.82, depthTest: false }),
    );
    this.preview.visible = false;
    this.previewRing.visible = false;
    this.scene.add(this.preview, this.previewRing);

    // Сплошная линия траектории (расчет траектории на CPU по точкам).
    const predictionPoints = new Float32Array(120 * 3);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(predictionPoints, 3));
    this.vectorLine = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({ color: 0x62c8ff, transparent: true, opacity: 0.65, depthTest: false }),
    );
    this.vectorLine.visible = false;
    this.vectorLine.frustumCulled = false;
    this.vectorLine.renderOrder = 5;
    // Наконечник-стрелка: остриё в локальном (0,0), направлено вдоль +X.
    const arrowGeometry = new THREE.BufferGeometry();
    arrowGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      0, 0, 0,
      -1.7, 0.85, 0,
      -1.7, -0.85, 0,
    ]), 3));
    this.vectorArrow = new THREE.Mesh(
      arrowGeometry,
      new THREE.MeshBasicMaterial({ color: 0x9fe1ff, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }),
    );
    this.vectorArrow.visible = false;
    this.vectorArrow.frustumCulled = false;
    this.vectorArrow.renderOrder = 6;
    this.scene.add(this.vectorLine, this.vectorArrow);

    // Пул вспышек столкновений: яркий блик (glow) + расходящаяся ударная волна (ring).
    // Живёт в отдельной сцене, чтобы не попадать в накопленный след.
    for (let index = 0; index < FLASH_POOL_SIZE; index += 1) {
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(1, 28),
        new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.86, 1, 48),
        new THREE.MeshBasicMaterial({ color: 0xffd6a0, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending }),
      );
      glow.visible = false;
      ring.visible = false;
      glow.frustumCulled = false;
      ring.frustumCulled = false;
      this.flashScene.add(glow, ring);
      this.flashes.push({ glow, ring, active: false, start: 0, x: 0, y: 0, strength: 1 });
    }

    this.gridScene.add(this.createGrid());

    this.trailRead = this.createTrailTarget(1, 1);
    this.trailWrite = this.createTrailTarget(1, 1);

    this.trailFadeUniforms = {
      u_prevTrail: { value: this.trailRead.texture },
      u_fade: { value: TRAIL_FADE },
      u_resolution: { value: new THREE.Vector2(1, 1) },
      u_cameraCurrent: { value: new THREE.Vector3() },
      u_cameraPrevious: { value: new THREE.Vector3() },
    };
    this.trailScene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.trailFadeUniforms,
        vertexShader: fullscreenVertexShader,
        fragmentShader: trailFadeShader,
        depthTest: false,
        depthWrite: false,
      }),
    ));

    this.trailCompositeUniforms = {
      u_trail: { value: this.trailWrite.texture },
      u_intensity: { value: TRAIL_INTENSITY },
    };
    this.trailComposite.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.trailCompositeUniforms,
        vertexShader: fullscreenVertexShader,
        fragmentShader: trailCompositeShader,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    ));
  }

  // Сетка пространства-времени: отрезки между узлами, каждый узел искривляется в
  // шейдере под действием тел. Живёт в своей сцене, рисуется под телами.
  private createGrid(): THREE.LineSegments {
    const positions: number[] = [];
    for (let y = -GRID_COUNT; y <= GRID_COUNT; y++) {
      for (let x = -GRID_COUNT; x < GRID_COUNT; x++) {
        positions.push(x, y, 0, x + 1, y, 0);
      }
    }
    for (let x = -GRID_COUNT; x <= GRID_COUNT; x++) {
      for (let y = -GRID_COUNT; y < GRID_COUNT; y++) {
        positions.push(x, y, 0, x, y + 1, 0);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.gridUniforms = {
      u_positions: { value: this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture },
      u_warp: { value: GRID_WARP },
      u_gridOffset: { value: new THREE.Vector2(0, 0) },
      u_gridStep: { value: 150 },
      u_color: { value: new THREE.Color(0x9a9ca0) },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.gridUniforms,
      vertexShader: gridVertexShader,
      fragmentShader: gridFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const grid = new THREE.LineSegments(geometry, material);
    grid.frustumCulled = false;
    return grid;
  }

  private createTrailTarget(width: number, height: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    const targetWidth = Math.max(1, Math.round(this.width * this.pixelRatio));
    const targetHeight = Math.max(1, Math.round(this.height * this.pixelRatio));
    this.trailRead.setSize(targetWidth, targetHeight);
    this.trailWrite.setSize(targetWidth, targetHeight);
    this.clearTrail();
  }

  private clearTrail(): void {
    const previousTarget = this.renderer.getRenderTarget();
    this.renderer.getClearColor(this.clearColorCache);
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.trailRead);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(this.trailWrite);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(this.clearColorCache, previousAlpha);
    this.hasPreviousCamera = false;
  }

  injectBody(position: Vec2, velocity: Vec2, radius: number, customMass?: number): number | null {
    let slot = -1;
    for (let index = 0; index < MAIN_BODY_COUNT; index += 1) {
      if (!this.occupiedMain[index] && !this.pendingDeletionMain[index]) {
        slot = index;
        break;
      }
    }
    if (slot < 0) return null;
    this.occupiedMain[slot] = 1;
    this.injectionQueue.push({ slot, position: { ...position }, velocity: { ...velocity }, radius, customMass });
    return slot;
  }

  deleteBody(slot: number): void {
    this.deletionQueue.push(slot);
    if (slot < MAIN_BODY_COUNT) {
      this.occupiedMain[slot] = 0;
      this.pendingDeletionMain[slot] = 1;
    }
  }

  // Подсветка выбранного тела на холсте; -1 — ничего не выбрано.
  setSelected(slot: number): void {
    if (this.particleUniforms) this.particleUniforms.uSelectedSlot.value = slot;
  }

  // Запустить вспышку столкновения в точке. strength ~ масштаб события (по массе).
  spawnFlash(position: Vec2, strength: number): void {
    const flash = this.flashes.find((candidate) => !candidate.active);
    if (!flash) return;
    flash.active = true;
    flash.start = this.elapsed;
    flash.x = position.x;
    flash.y = position.y;
    flash.strength = Math.min(3.5, Math.max(0.7, strength));
  }

  private updateFlashes(): void {
    for (const flash of this.flashes) {
      if (!flash.active) continue;
      const age = this.elapsed - flash.start;
      if (age < 0 || age > FLASH_DURATION) {
        flash.active = false;
        flash.glow.visible = false;
        flash.ring.visible = false;
        continue;
      }
      const t = age / FLASH_DURATION;
      const screenX = flash.x;
      const screenY = -flash.y;
      // Блик: вспыхивает и быстро тухнет.
      const glowScale = flash.strength * (7.0 + t * 5.0);
      flash.glow.visible = true;
      flash.glow.position.set(screenX, screenY, 0.4);
      flash.glow.scale.set(glowScale, glowScale, 1);
      (flash.glow.material as THREE.MeshBasicMaterial).opacity = (1.0 - t) * (1.0 - t) * 0.8;
      // Ударная волна: кольцо быстро расширяется и истончается.
      const ringScale = flash.strength * (5.0 + t * t * 70.0);
      flash.ring.visible = true;
      flash.ring.position.set(screenX, screenY, 0.4);
      flash.ring.scale.set(ringScale, ringScale, 1);
      (flash.ring.material as THREE.MeshBasicMaterial).opacity = (1.0 - t) * 0.55;
    }
  }

  step(dt: number): void {
    this.elapsed += dt;
    const injection = this.injectionQueue.shift();
    const deletion = this.deletionQueue.shift();
    this.setStepUniforms(this.positionVariable, dt, injection, deletion, 0, false);
    this.setStepUniforms(this.velocityVariable, dt, injection, deletion, 0, false);
    this.gpuCompute.compute();
    if (deletion !== undefined && deletion < MAIN_BODY_COUNT) this.pendingDeletionMain[deletion] = 0;

    // Вторая половина velocity Verlet: события уже применены, ускорение берётся
    // из новых позиций после drift-фазы.
    this.setStepUniforms(this.positionVariable, dt, undefined, undefined, 1, false);
    this.setStepUniforms(this.velocityVariable, dt, undefined, undefined, 1, false);
    this.gpuCompute.compute();
  }

  flushPendingMutations(): boolean {
    const injection = this.injectionQueue.shift();
    const deletion = this.deletionQueue.shift();
    if (!injection && deletion === undefined) return false;
    this.setStepUniforms(this.positionVariable, 0, injection, deletion, 0, true);
    this.setStepUniforms(this.velocityVariable, 0, injection, deletion, 0, true);
    this.gpuCompute.compute();
    if (deletion !== undefined && deletion < MAIN_BODY_COUNT) this.pendingDeletionMain[deletion] = 0;
    return true;
  }

  render(cameraState: CameraState, preview: CreationPreview | null, snapshots: BodySnapshot[] = []): void {
    this.syncCamera(cameraState);
    if (this.particleUniforms) {
      this.particleUniforms.texturePosition.value = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;
      this.particleUniforms.textureVelocity.value = this.gpuCompute.getCurrentRenderTarget(this.velocityVariable).texture;
      this.particleUniforms.uTime.value = this.elapsed;
    }

    if (!this.hasPreviousCamera) {
      this.previousCamera.x = cameraState.x;
      this.previousCamera.y = cameraState.y;
      this.previousCamera.zoom = cameraState.zoom;
      this.hasPreviousCamera = true;
    }

    this.renderer.autoClear = false;

    // 1. Сдвигаем и гасим прошлый след в trailWrite (с учётом движения камеры).
    this.trailFadeUniforms.u_prevTrail.value = this.trailRead.texture;
    (this.trailFadeUniforms.u_resolution.value as THREE.Vector2).set(this.width, this.height);
    (this.trailFadeUniforms.u_cameraCurrent.value as THREE.Vector3).set(cameraState.x, cameraState.y, cameraState.zoom);
    (this.trailFadeUniforms.u_cameraPrevious.value as THREE.Vector3).set(
      this.previousCamera.x,
      this.previousCamera.y,
      this.previousCamera.zoom,
    );
    this.renderer.setRenderTarget(this.trailWrite);
    this.renderer.render(this.trailScene, this.fullscreenCamera);

    // 2. Подмешиваем текущие тела в накопленный след узкими точками-центрами
    //    (превью в след не попадает).
    this.hidePreview();
    if (this.particleUniforms) this.particleUniforms.uTrailMode.value = 1;
    this.renderer.render(this.scene, this.camera);
    if (this.particleUniforms) this.particleUniforms.uTrailMode.value = 0;

    // 3. Кадр на экран: фон, затем аддитивный след поверх него.
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, true);
    this.trailCompositeUniforms.u_trail.value = this.trailWrite.texture;
    this.renderer.render(this.trailComposite, this.fullscreenCamera);

    // 3b. Искривлённая сетка пространства-времени — под телами. Привязка к камере
    //     (snap к шагу) делает сетку видимой везде при панорамировании на любые расстояния.
    if (this.gridUniforms) {
      this.gridUniforms.u_positions.value = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;
      const zoom = cameraState.zoom;
      const currentStep = 150 * Math.pow(2, Math.floor(Math.log2(1 / zoom)));
      this.gridUniforms.u_gridStep.value = currentStep;
      const snapX = Math.round(cameraState.x / currentStep) * currentStep;
      const snapY = Math.round(cameraState.y / currentStep) * currentStep;
      (this.gridUniforms.u_gridOffset.value as THREE.Vector2).set(snapX, snapY);
    }
    this.renderer.render(this.gridScene, this.camera);

    // 4. Чёткие тела и превью поверх следа.
    this.updatePreview(preview, cameraState.zoom, snapshots);
    this.renderer.render(this.scene, this.camera);

    // 5. Вспышки столкновений поверх всего (отдельная сцена -> в след не попадают).
    this.updateFlashes();
    this.renderer.render(this.flashScene, this.camera);

    this.renderer.autoClear = true;

    const swap = this.trailRead;
    this.trailRead = this.trailWrite;
    this.trailWrite = swap;
    this.previousCamera.x = cameraState.x;
    this.previousCamera.y = cameraState.y;
    this.previousCamera.zoom = cameraState.zoom;
  }

  private hidePreview(): void {
    this.preview.visible = false;
    this.previewRing.visible = false;
    this.vectorLine.visible = false;
    this.vectorArrow.visible = false;
  }

  readSnapshot(): BodySnapshot[] {
    this.renderer.readRenderTargetPixels(
      this.gpuCompute.getCurrentRenderTarget(this.positionVariable),
      0,
      0,
      TEXTURE_SIZE,
      TEXTURE_SIZE,
      this.positionReadback,
    );
    this.renderer.readRenderTargetPixels(
      this.gpuCompute.getCurrentRenderTarget(this.velocityVariable),
      0,
      0,
      TEXTURE_SIZE,
      TEXTURE_SIZE,
      this.velocityReadback,
    );

    this.occupiedMain.fill(0);
    const snapshots: BodySnapshot[] = [];
    for (let slot = 0; slot < PARTICLE_COUNT; slot += 1) {
      const offset = slot * 4;
      const mass = this.positionReadback[offset + 2];
      if (!(mass > 0)) continue;
      const isFragment = slot >= MAIN_BODY_COUNT;
      if (!isFragment) this.occupiedMain[slot] = 1;
      const vx = this.velocityReadback[offset];
      const vy = this.velocityReadback[offset + 1];
      const radius = this.positionReadback[offset + 3];
      // Тот же критерий «температуры», что в шейдере -> цвет точки в сайдбаре
      // совпадает с цветом тела на холсте: красный (холодно) … голубой (горячо).
      const heat = 1 - Math.exp(-(mass * 0.012 + Math.hypot(vx, vy) * 0.005));
      snapshots.push({
        id: slot,
        name: `Небесное тело ${slot + 1}`,
        position: { x: this.positionReadback[offset], y: this.positionReadback[offset + 1] },
        velocity: { x: vx, y: vy },
        mass,
        radius,
        // Та же величина, что bodyDensity() в шейдере: масса на единицу площади.
        density: radius > 0 ? mass / (radius * radius) : 0,
        hue: Math.round(15 + heat * 200),
        isFragment,
      });
    }
    return snapshots;
  }

  private addComputeUniforms(variable: Variable): void {
    Object.assign(variable.material.uniforms, {
      u_dt: { value: 0 },
      u_time: { value: 0 },
      u_phase: { value: 0 },
      u_mutationOnly: { value: 0 },
      u_injectSlot: { value: -1 },
      u_deleteSlot: { value: -1 },
      u_injectPosition: { value: new THREE.Vector4() },
      u_injectVelocity: { value: new THREE.Vector4() },
    });
  }

  private setStepUniforms(
    variable: Variable,
    dt: number,
    injection?: Injection,
    deletion?: number,
    phase = 0,
    mutationOnly = false,
  ): void {
    const uniforms = variable.material.uniforms;
    uniforms.u_dt.value = dt;
    uniforms.u_time.value = this.elapsed;
    uniforms.u_phase.value = phase;
    uniforms.u_mutationOnly.value = mutationOnly ? 1 : 0;
    uniforms.u_deleteSlot.value = deletion ?? -1;
    uniforms.u_injectSlot.value = injection?.slot ?? -1;
    if (injection) {
      const mass = injection.customMass !== undefined ? injection.customMass : injection.radius * injection.radius * MASS_DENSITY;
      (uniforms.u_injectPosition.value as THREE.Vector4).set(
        injection.position.x,
        injection.position.y,
        mass,
        injection.radius,
      );
      (uniforms.u_injectVelocity.value as THREE.Vector4).set(
        injection.velocity.x,
        injection.velocity.y,
        -1,
        0,
      );
    }
  }

  private createParticleGeometry(): THREE.BufferGeometry {
    const corners = [
      [-1, -1], [1, -1], [1, 1],
      [-1, -1], [1, 1], [-1, 1],
    ];
    const verticesPerBody = corners.length;
    const positions = new Float32Array(PARTICLE_COUNT * verticesPerBody * 3);
    const references = new Float32Array(PARTICLE_COUNT * verticesPerBody * 2);
    const indices = new Float32Array(PARTICLE_COUNT * verticesPerBody);
    for (let slot = 0; slot < PARTICLE_COUNT; slot += 1) {
      const referenceX = (slot % TEXTURE_SIZE + 0.5) / TEXTURE_SIZE;
      const referenceY = (Math.floor(slot / TEXTURE_SIZE) + 0.5) / TEXTURE_SIZE;
      for (let vertex = 0; vertex < verticesPerBody; vertex += 1) {
        const target = slot * verticesPerBody + vertex;
        positions[target * 3] = corners[vertex][0];
        positions[target * 3 + 1] = corners[vertex][1];
        references[target * 2] = referenceX;
        references[target * 2 + 1] = referenceY;
        indices[target] = slot;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("reference", new THREE.BufferAttribute(references, 2));
    geometry.setAttribute("slotIndex", new THREE.BufferAttribute(indices, 1));
    return geometry;
  }

  private syncCamera(state: CameraState): void {
    this.camera.left = -this.width / (2 * state.zoom);
    this.camera.right = this.width / (2 * state.zoom);
    this.camera.top = this.height / (2 * state.zoom);
    this.camera.bottom = -this.height / (2 * state.zoom);
    this.camera.position.set(state.x, -state.y, 10);
    this.camera.updateProjectionMatrix();
  }

  private updatePreview(preview: CreationPreview | null, zoom: number, snapshots: BodySnapshot[]): void {
    if (!preview) {
      this.hidePreview();
      return;
    }
    const radius = preview.radius;
    this.preview.visible = true;
    this.previewRing.visible = true;
    this.preview.position.set(preview.position.x, -preview.position.y, 0.3);
    this.previewRing.position.copy(this.preview.position);
    this.preview.scale.set(radius, radius, 1);
    this.previewRing.scale.set(radius, radius, 1);

    const hasVector = Boolean(preview.vectorEnd);
    this.vectorLine.visible = hasVector;
    this.vectorArrow.visible = hasVector;
    if (preview.vectorEnd) {
      // Расчет траектории движения нового тела на CPU
      const positions = this.vectorLine.geometry.getAttribute("position") as THREE.BufferAttribute;
      let px = preview.position.x;
      let py = preview.position.y;
      let vx = (preview.vectorEnd.x - preview.position.x) * 0.7; // VELOCITY_SCALE = 0.7
      let vy = (preview.vectorEnd.y - preview.position.y) * 0.7;

      const predictionSteps = 120;
      const predictionDt = 0.12; // шаг времени для прогноза

      for (let i = 0; i < predictionSteps; i++) {
        positions.setXYZ(i, px, -py, 0.35);

        // Влияние гравитации всех существующих тел
        let ax = 0;
        let ay = 0;
        for (const body of snapshots) {
          const dx = body.position.x - px;
          const dy = body.position.y - py;
          const distSq = dx * dx + dy * dy + 12.0 * 12.0; // SOFTENING = 12.0
          const dist = Math.sqrt(distSq);
          const f = (9500.0 * body.mass) / (distSq * dist); // G = 9500.0
          ax += f * dx;
          ay += f * dy;
        }

        // Обновление положения и скорости
        px += vx * predictionDt;
        py += vy * predictionDt;
        vx += ax * predictionDt;
        vy += ay * predictionDt;
      }
      positions.needsUpdate = true;

      // Наконечник стрелки
      const dx = preview.vectorEnd.x - preview.position.x;
      const dy = -(preview.vectorEnd.y - preview.position.y);
      this.vectorArrow.position.set(preview.vectorEnd.x, -preview.vectorEnd.y, 0.36);
      this.vectorArrow.rotation.z = Math.atan2(dy, dx);
      const arrowScale = 10 / zoom;
      this.vectorArrow.scale.set(arrowScale, arrowScale, 1);
    }
  }
}
