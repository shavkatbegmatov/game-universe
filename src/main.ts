import "./style.css";
import { GPUEngine, type BodySnapshot, type CameraState, type CreationPreview, type Vec2 } from "./gpu-engine";
import { BodiesSidebar } from "./ui";
import { SpaceAudio } from "./audio";
import { OBJECT_TYPES, OBJECT_TYPE_MAP, massFor, type ObjectType, type ObjectTypeId } from "./object-types";

type InteractionMode = "idle" | "create" | "pan";
type CreationStyle = "growing" | "vector";
type CursorMode = "create" | "select";

const canvas = document.querySelector<HTMLCanvasElement>("#space-canvas")!;
const pauseButton = document.querySelector<HTMLButtonElement>("#pause-button")!;
const pauseLabel = document.querySelector<HTMLElement>("#pause-label")!;
const instruction = document.querySelector<HTMLElement>("#instruction")!;
const statusPill = document.querySelector<HTMLElement>("#status-pill")!;
const zoomValue = document.querySelector<HTMLElement>("#zoom-value")!;
const cameraCoords = document.querySelector<HTMLElement>("#camera-coords")!;
const resetCameraButton = document.querySelector<HTMLButtonElement>("#reset-camera")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
const modeCreateButton = document.querySelector<HTMLButtonElement>("#mode-create")!;
const modeSelectButton = document.querySelector<HTMLButtonElement>("#mode-select")!;

// Yangi boshqaruv elementlari
const soundButton = document.querySelector<HTMLButtonElement>("#sound-button")!;
const soundIcon = soundButton.querySelector<HTMLElement>(".sound-icon")!;
const soundLabel = document.querySelector<HTMLElement>("#sound-label")!;
const fpsCounter = document.querySelector<HTMLElement>("#fps-counter")!;

const timeButtons = document.querySelectorAll<HTMLButtonElement>(".time-btn");

const typePalette = document.querySelector<HTMLElement>("#type-palette")!;
const inspectorDot = document.querySelector<HTMLElement>("#inspector-dot")!;
const inspectorName = document.querySelector<HTMLElement>("#inspector-name")!;
const inspectorRadius = document.querySelector<HTMLElement>("#inspector-radius")!;
const inspectorMass = document.querySelector<HTMLElement>("#inspector-mass")!;
const inspectorDensity = document.querySelector<HTMLElement>("#inspector-density")!;
const inspectorHint = document.querySelector<HTMLElement>("#inspector-hint")!;

const scenarioSolarBtn = document.querySelector<HTMLButtonElement>("#scenario-solar")!;
const scenarioBinaryBtn = document.querySelector<HTMLButtonElement>("#scenario-binary")!;
const scenarioChaosBtn = document.querySelector<HTMLButtonElement>("#scenario-chaos")!;
const scenarioClearBtn = document.querySelector<HTMLButtonElement>("#scenario-clear")!;

const engine = new GPUEngine(canvas);
const camera: CameraState = { x: 0, y: 0, zoom: 1 };
const sidebar = new BodiesSidebar(focusBody, deleteBody);
const audio = new SpaceAudio();

const FIXED_STEP = 1 / 90;
const MAX_FRAME_TIME = 0.05;
const MAX_SUBSTEPS = 5;
// Скорость роста радиуса при удержании (ед/с). Радиус растёт от minRadius выбранного
// типа до его maxRadius; масса выводится как density * r^2 (см. object-types.ts).
const HOLD_GROWTH_RATE = 11;
const VECTOR_THRESHOLD_PX = 10;
const VELOCITY_SCALE = 0.7;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 50;

let width = 1;
let height = 1;
let paused = false;
let lastTime = performance.now();
let accumulator = 0;
let lastUiUpdate = 0;
let snapshots: BodySnapshot[] = [];
let interactionMode: InteractionMode = "idle";
let creationStyle: CreationStyle = "growing";
let cursorMode: CursorMode = "create";
let selectedId: number | null = null;
let pointerId: number | null = null;
let spacePressed = false;
let holdStartedAt = 0;
let frozenRadius = 8;
let dragStartScreen: Vec2 = { x: 0, y: 0 };
let dragStartWorld: Vec2 = { x: 0, y: 0 };
let dragCurrentWorld: Vec2 = { x: 0, y: 0 };
let panLastScreen: Vec2 = { x: 0, y: 0 };
let noticeTimer = 0;

// O'yin rejimi sozlamalari
let soundEnabled = false;
let timeSpeed = 1;
let selectedTypeId: ObjectTypeId = "rocky";
let isDeletingOrClearing = false;

// FPS hisoblash o'zgaruvchilari
let fpsTime = performance.now();
let fpsFrames = 0;

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 2600);
}

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  width = Math.max(1, rect.width);
  height = Math.max(1, rect.height);
  engine.resize(width, height);
}

function pointerScreenPosition(event: PointerEvent | WheelEvent): Vec2 {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function screenToWorld(point: Vec2): Vec2 {
  return {
    x: camera.x + (point.x - width / 2) / camera.zoom,
    y: camera.y + (point.y - height / 2) / camera.zoom,
  };
}

function currentGrowthRadius(now = performance.now()): number {
  const type = OBJECT_TYPE_MAP[selectedTypeId];
  if (creationStyle === "vector") return frozenRadius;
  // Удержание наращивает радиус от minRadius к maxRadius выбранного типа.
  const grown = type.minRadius + Math.max(0, now - holdStartedAt) / 1000 * HOLD_GROWTH_RATE;
  return Math.min(type.maxRadius, grown);
}

function focusBody(id: number): void {
  const body = snapshots.find((candidate) => candidate.id === id);
  if (body) {
    camera.x = body.position.x;
    camera.y = body.position.y;
  }
  selectBody(id);
}

function selectBody(id: number | null): void {
  selectedId = id;
  engine.setSelected(id ?? -1);
  sidebar.setSelected(id);
  sidebar.update(snapshots);
}

function deleteBody(id: number): void {
  isDeletingOrClearing = true;
  if (selectedId === id) selectBody(null);
  engine.deleteBody(id);
}

// Ovoz boshqaruvi event listener'i
soundButton.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  soundButton.setAttribute("aria-pressed", String(soundEnabled));
  soundButton.classList.toggle("is-playing", soundEnabled);
  soundIcon.textContent = soundEnabled ? "🔊" : "🔈";
  soundLabel.textContent = soundEnabled ? "Звук: Вкл" : "Звук: Выкл";
  audio.toggle(soundEnabled);
});

// Tezlikni boshqarish tugmalari listener'i
timeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    timeButtons.forEach(b => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    timeSpeed = parseInt(btn.getAttribute("data-speed") || "1", 10);
  });
});

// Палитра типов тел + живой инспектор. Палитра строится из единого реестра
// OBJECT_TYPES, поэтому добавление нового типа не требует правок в HTML.
const typeButtons = new Map<ObjectTypeId, HTMLButtonElement>();

function formatMass(mass: number): string {
  if (mass >= 1000) return Math.round(mass).toLocaleString("ru-RU");
  if (mass >= 100) return Math.round(mass).toString();
  return mass.toFixed(1);
}

function updateInspector(): void {
  const type = OBJECT_TYPE_MAP[selectedTypeId];
  // Во время создания показываем живой радиус, иначе — радиус по умолчанию.
  const radius = interactionMode === "create" ? currentGrowthRadius() : type.defaultRadius;
  inspectorDot.style.setProperty("--type-accent", type.accent);
  inspectorName.textContent = type.name;
  inspectorRadius.textContent = radius.toFixed(1);
  inspectorMass.textContent = formatMass(massFor(type, radius));
  inspectorDensity.textContent = type.density.toFixed(2);
  inspectorHint.textContent = type.hint;
}

function selectType(id: ObjectTypeId): void {
  selectedTypeId = id;
  for (const [typeId, button] of typeButtons) {
    const active = typeId === id;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  updateInspector();
}

for (const type of OBJECT_TYPES) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "type-chip";
  button.dataset.type = type.id;
  button.title = type.hint;
  button.setAttribute("aria-pressed", String(type.id === selectedTypeId));
  if (type.id === selectedTypeId) button.classList.add("is-active");
  button.innerHTML =
    `<span class="type-chip-dot" style="--type-accent: ${type.accent}"></span>` +
    `<span class="type-chip-name">${type.name}</span>`;
  button.addEventListener("click", () => selectType(type.id));
  typePalette.appendChild(button);
  typeButtons.set(type.id, button);
}
updateInspector();

// Ssenariylar boshqaruvi
scenarioClearBtn.addEventListener("click", () => {
  clearAllBodies();
  showNotice("Koinot tozalandi!");
});

scenarioSolarBtn.addEventListener("click", () => {
  clearAllBodies();
  setTimeout(() => {
    // Quyosh tizimi: markazda haqiqiy yulduz (zichlik 0.6 -> yulduz ko'rinishi),
    // massasi orbital tezliklarni belgilaydi.
    const starPos = { x: 0, y: 0 };
    const sunRadius = 80;
    const starMass = massFor(OBJECT_TYPE_MAP.star, sunRadius); // 0.6 * 80^2 = 3840
    engine.injectBody(starPos, { x: 0, y: 0 }, sunRadius, starMass);

    // Tosh planetalar va tashqi gaz giganti — barchasi taksonomiyaga mos.
    spawnCircularOrbit(starPos, starMass, 200, 7);
    spawnCircularOrbit(starPos, starMass, 300, 10);
    spawnCircularOrbit(starPos, starMass, 420, 13);
    spawnCircularOrbit(starPos, starMass, 560, 48, OBJECT_TYPE_MAP.gasGiant);

    showNotice("Quyosh tizimi yuklandi!");
  }, 100);
});

scenarioBinaryBtn.addEventListener("click", () => {
  clearAllBodies();
  setTimeout(() => {
    // Ikkita haqiqiy yulduz (zichlik 0.6) barqaror o'zaro orbitada. Aylana binar
    // orbitasi uchun: v = sqrt(G * m / (2 * d)), d — yulduzlar orasidagi masofa.
    const starR = 48;
    const m = massFor(OBJECT_TYPE_MAP.star, starR); // 0.6 * 48^2 = 1382.4
    const separation = 320;
    const vBin = Math.sqrt((9500 * m) / (2 * separation));
    engine.injectBody({ x: -160, y: 0 }, { x: 0, y: vBin }, starR, m);
    engine.injectBody({ x: 160, y: 0 }, { x: 0, y: -vBin }, starR, m);

    // Yo'ldosh planeta — ikkala yulduzning umumiy massasi atrofida aylanadi.
    spawnCircularOrbit({ x: 0, y: 0 }, 2 * m, 460, 9);

    showNotice("Qo'shaloq yulduz ssenariysi yuklandi!");
  }, 100);
});

scenarioChaosBtn.addEventListener("click", () => {
  clearAllBodies();
  setTimeout(() => {
    // Tasodifiy xaotik jismlar (N-body stress-test)
    const count = 18;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 180 + Math.random() * 320;
      const px = Math.cos(angle) * dist;
      const py = Math.sin(angle) * dist;

      // Aylana bo'ylab tasodifiy tezlik
      const v = 8 + Math.random() * 12;
      const vx = -Math.sin(angle) * v + (Math.random() - 0.5) * 5;
      const vy = Math.cos(angle) * v + (Math.random() - 0.5) * 5;

      const radius = 6 + Math.random() * 12;
      engine.injectBody({ x: px, y: py }, { x: vx, y: vy }, radius);
    }
    showNotice("Xaotik to'qnashuv yuklandi!");
  }, 100);
});

function clearAllBodies(): void {
  isDeletingOrClearing = true;
  selectBody(null);
  snapshots.forEach(b => engine.deleteBody(b.id));
}

function spawnCircularOrbit(starPos: Vec2, starMass: number, distance: number, radius: number, type: ObjectType = OBJECT_TYPE_MAP.rocky): void {
  const angle = Math.random() * Math.PI * 2;
  const px = starPos.x + Math.cos(angle) * distance;
  const py = starPos.y + Math.sin(angle) * distance;

  // Aylana orbitasi tezligi magnitude
  const v = Math.sqrt((9500.0 * starMass) / distance);

  // Tezlik vektori pozitsiyaga perpendikulyar
  const vx = -Math.sin(angle) * v;
  const vy = Math.cos(angle) * v;

  // Massa tur zichligidan: orbital tana ham taksonomiyaga mos (planeta, gaz giganti...).
  engine.injectBody({ x: px, y: py }, { x: vx, y: vy }, radius, massFor(type, radius));
}

// Какое тело под точкой (мировые координаты): ближайшее, в чей радиус попал клик.
function hitTest(worldPoint: Vec2): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  const minPickRadius = 14 / camera.zoom;
  for (const body of snapshots) {
    const distance = Math.hypot(body.position.x - worldPoint.x, body.position.y - worldPoint.y);
    const pickRadius = Math.max(body.radius, minPickRadius);
    if (distance <= pickRadius && distance < bestDistance) {
      bestDistance = distance;
      best = body.id;
    }
  }
  return best;
}

function setCursorMode(mode: CursorMode): void {
  if (cursorMode === mode) return;
  cursorMode = mode;
  modeCreateButton.classList.toggle("is-active", mode === "create");
  modeSelectButton.classList.toggle("is-active", mode === "select");
  modeCreateButton.setAttribute("aria-pressed", String(mode === "create"));
  modeSelectButton.setAttribute("aria-pressed", String(mode === "select"));
  canvas.classList.toggle("mode-select", mode === "select");
  if (mode === "create") selectBody(null);
}

function creationPreview(now: number): CreationPreview | null {
  if (interactionMode !== "create") return null;
  return {
    position: dragStartWorld,
    radius: currentGrowthRadius(now),
    vectorEnd: creationStyle === "vector" ? dragCurrentWorld : undefined,
  };
}

function endInteraction(): void {
  interactionMode = "idle";
  creationStyle = "growing";
  pointerId = null;
  canvas.classList.remove("is-aiming", "is-panning");
  canvas.classList.toggle("space-ready", spacePressed);
  // Инспектор возвращается к параметрам по умолчанию выбранного типа.
  updateInspector();
}

canvas.addEventListener("pointerdown", (event) => {
  const shouldPan = event.button === 1 || (event.button === 0 && spacePressed);
  if (!shouldPan && event.button !== 0) return;
  event.preventDefault();

  // Режим выбора: ЛКМ только выделяет тело — без создания и без захвата указателя.
  if (!shouldPan && cursorMode === "select") {
    selectBody(hitTest(screenToWorld(pointerScreenPosition(event))));
    return;
  }

  pointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);

  if (shouldPan) {
    interactionMode = "pan";
    panLastScreen = pointerScreenPosition(event);
    canvas.classList.add("is-panning");
    canvas.classList.remove("space-ready");
    return;
  }

  interactionMode = "create";
  creationStyle = "growing";
  holdStartedAt = performance.now();
  frozenRadius = OBJECT_TYPE_MAP[selectedTypeId].minRadius;
  dragStartScreen = pointerScreenPosition(event);
  dragStartWorld = screenToWorld(dragStartScreen);
  dragCurrentWorld = { ...dragStartWorld };
  canvas.classList.add("is-aiming");
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== pointerId) return;
  const screenPosition = pointerScreenPosition(event);

  if (interactionMode === "pan") {
    camera.x -= (screenPosition.x - panLastScreen.x) / camera.zoom;
    camera.y -= (screenPosition.y - panLastScreen.y) / camera.zoom;
    panLastScreen = screenPosition;
    return;
  }

  if (interactionMode === "create") {
    dragCurrentWorld = screenToWorld(screenPosition);
    // Перетягивание дальше порога фиксирует радиус и переходит к заданию вектора
    // скорости — единое поведение для всех типов тел.
    if (
      creationStyle === "growing" &&
      Math.hypot(screenPosition.x - dragStartScreen.x, screenPosition.y - dragStartScreen.y) > VECTOR_THRESHOLD_PX
    ) {
      frozenRadius = currentGrowthRadius();
      creationStyle = "vector";
    }
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerId !== pointerId) return;
  if (interactionMode === "create") {
    dragCurrentWorld = screenToWorld(pointerScreenPosition(event));
    const velocity = creationStyle === "vector"
      ? {
          x: (dragCurrentWorld.x - dragStartWorld.x) * VELOCITY_SCALE,
          y: (dragCurrentWorld.y - dragStartWorld.y) * VELOCITY_SCALE,
        }
      : { x: 0, y: 0 };
    
    // Радиус (с учётом удержания) и плотность типа задают массу: mass = density * r^2.
    const type = OBJECT_TYPE_MAP[selectedTypeId];
    const radius = currentGrowthRadius();
    const mass = massFor(type, radius);
    const created = engine.injectBody(dragStartWorld, velocity, radius, mass) !== null;

    if (created) {
      instruction.classList.add("is-hidden");
      audio.playCreation(mass);
    } else {
      showNotice("Лимит основных тел достигнут (256)");
    }
  }
  endInteraction();
});

canvas.addEventListener("pointercancel", endInteraction);
canvas.addEventListener("auxclick", (event) => {
  if (event.button === 1) event.preventDefault();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const cursor = pointerScreenPosition(event);
  const worldUnderCursor = screenToWorld(cursor);
  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
  camera.x = worldUnderCursor.x - (cursor.x - width / 2) / camera.zoom;
  camera.y = worldUnderCursor.y - (cursor.y - height / 2) / camera.zoom;
  zoomValue.textContent = `${Math.round(camera.zoom * 100)}%`;
}, { passive: false });

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const target = event.target as HTMLElement | null;
  if (target?.matches("button, input, textarea, select")) return;
  event.preventDefault();
  spacePressed = true;
  if (interactionMode === "idle") canvas.classList.add("space-ready");
});

window.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  spacePressed = false;
  if (interactionMode === "idle") canvas.classList.remove("space-ready");
});

window.addEventListener("blur", () => {
  spacePressed = false;
  if (interactionMode === "idle") canvas.classList.remove("space-ready");
});

pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.setAttribute("aria-pressed", String(paused));
  pauseButton.classList.toggle("is-paused", paused);
  pauseLabel.textContent = paused ? "Продолжить" : "Пауза";
  statusPill.hidden = !paused;
  accumulator = 0;
  lastTime = performance.now();
});

resetCameraButton.addEventListener("click", () => {
  camera.x = 0;
  camera.y = 0;
  camera.zoom = 1;
  zoomValue.textContent = "100%";
});

modeCreateButton.addEventListener("click", () => setCursorMode("create"));
modeSelectButton.addEventListener("click", () => setCursorMode("select"));

function frame(now: number): void {
  // FPS hisoblash
  fpsFrames += 1;
  if (now - fpsTime >= 1000) {
    fpsCounter.textContent = String(Math.round((fpsFrames * 1000) / (now - fpsTime)));
    fpsFrames = 0;
    fpsTime = now;
  }

  // Vaqt tezligi simulyatsiya qadamiga ta'sir qiladi
  const frameTime = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME) * timeSpeed;
  lastTime = now;

  if (!paused) {
    accumulator += frameTime;
    let substeps = 0;
    while (accumulator >= FIXED_STEP && substeps < MAX_SUBSTEPS) {
      engine.step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      substeps += 1;
    }
    if (substeps === MAX_SUBSTEPS) accumulator = 0;
  } else {
    engine.flushPendingMutations();
  }

  if (now - lastUiUpdate > 180) {
    const fresh = engine.readSnapshot();
    
    // To'qnashuvlar (Shatter / Merge) tovushini o'ynash
    if (!isDeletingOrClearing && snapshots.length > 0) {
      const oldMainCount = snapshots.filter(b => !b.isFragment).length;
      const newMainCount = fresh.filter(b => !b.isFragment).length;
      
      const oldFragCount = snapshots.filter(b => b.isFragment).length;
      const newFragCount = fresh.filter(b => b.isFragment).length;

      if (newMainCount < oldMainCount) {
        // Ikkita jism to'qnashib, qo'shilib ketdi (Merge)
        audio.playMerge();
      } else if (newFragCount > oldFragCount) {
        // Kuchli zarb bilan parchalanish sodir bo'ldi (Shatter)
        audio.playShatter();
      }
    }
    isDeletingOrClearing = false;

    snapshots = fresh;
    sidebar.update(snapshots);
    instruction.classList.toggle("is-hidden", snapshots.length > 0);
    lastUiUpdate = now;
  }
  
  // Во время создания радиус растёт от удержания — обновляем инспектор вживую.
  if (interactionMode === "create") updateInspector();
  cameraCoords.textContent = `${Math.round(camera.x)}, ${Math.round(camera.y)}`;
  engine.render(camera, creationPreview(now), snapshots);
  requestAnimationFrame(frame);
}

window.addEventListener("resize", resize);
resize();
sidebar.update(snapshots);
requestAnimationFrame(frame);
