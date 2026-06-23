import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shaders = readFileSync(new URL("../src/gpu-shaders.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const engine = readFileSync(new URL("../src/gpu-engine.ts", import.meta.url), "utf8");
const objectTypes = readFileSync(new URL("../src/object-types.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

test("GPU step keeps both halves of velocity Verlet", () => {
  assert.match(shaders, /positionData\.xy \+= velocityData\.xy \* u_dt \+ 0\.5 \* acceleration \* u_dt \* u_dt/);
  assert.match(shaders, /velocityData\.xy \+= 0\.5 \* acceleration \* u_dt/);
  assert.match(shaders, /velocityData\.xy \+= 0\.5 \* gravityAcceleration\(selfIndex, positionData\.xy\) \* u_dt/);
});

test("fragmentation requires every destination slot and fragments expire", () => {
  assert.match(shaders, /if \(texture2D\(texturePosition, uvForIndex\(fragmentSlot\)\)\.z > 0\.0\) return false/);
  assert.match(shaders, /float life = 10\.0 \+ 5\.0/);
  assert.match(shaders, /velocityData\.z = max\(0\.0, velocityData\.z - u_dt\)/);
});

test("pause only flushes explicit mutations", () => {
  assert.match(main, /engine\.flushPendingMutations\(\)/);
  assert.doesNotMatch(main, /engine\.step\(0\)/);
});

test("mobile layout does not force a desktop minimum width", () => {
  const mobile = styles.slice(styles.indexOf("@media (max-width: 650px)"));
  assert.match(mobile, /min-width:\s*0/);
  assert.doesNotMatch(mobile, /min-width:\s*620px/);
});

test("collisions use one shared density-aware, escape-velocity regime model", () => {
  // Единая функция исхода вызывается всеми проходами -> масса/импульс не расходятся.
  assert.match(shaders, /float collisionRegime\(/);
  assert.match(shaders, /vEsc = sqrt\(2\.0 \* G \* totalMass/);
  assert.match(shaders, /densityRatio >= DENSITY_DOMINANCE/);
  // «магический» порог скорости больше не решает исход столкновения
  assert.doesNotMatch(shaders, /relativeSpeed >= FRAGMENT_SPEED/);
});

test("merge preserves the survivor's density (no black-hole ballooning)", () => {
  assert.match(shaders, /float kSurvivor = bodyDensity\(positionData\)/);
  assert.match(shaders, /sqrt\(totalMass \/ kSurvivor\)/);
  // прежний баг: радиус слияния по глобальной плотности раздувал чёрную дыру в пузырь
  assert.doesNotMatch(shaders, /sqrt\(totalMass \/ MASS_DENSITY\)/);
});

test("each body exposes a real density derived from mass and radius", () => {
  assert.match(engine, /density: radius > 0 \? mass \/ \(radius \* radius\) : 0/);
});

test("rendering classifies bodies by a density ladder, not raw mass", () => {
  assert.match(engine, /density = gpuPosition\.z \/ max\(gpuPosition\.w \* gpuPosition\.w/);
  assert.match(engine, /vDensity >= 120\.0/); // чёрная дыра
  assert.match(engine, /vDensity >= 45\.0/); // нейтронная звезда
  assert.match(engine, /vDensity >= 4\.0/); // белый карлик
  assert.match(engine, /vDensity >= 0\.3/); // звезда
  assert.match(engine, /vDensity < 0\.09/); // газовый гигант
  assert.doesNotMatch(engine, /step\(20000\.0, gpuPosition\.z\)/);
});

test("luminous bodies render a corona via an enlarged quad", () => {
  assert.match(engine, /varying float vGlowScale/);
  assert.match(engine, /gpuPosition\.w \* glowScale/); // увеличенный квадрат под ореол
  assert.match(engine, /float surface = 1\.0 \/ vGlowScale/);
});

test("rocky and gas-giant surfaces get per-body procedural detail", () => {
  assert.match(engine, /varying float vSeed/);
  assert.match(engine, /float vnoise\(vec2 p\)/);
  assert.match(engine, /vSeed = fract\(sin\(slotIndex/);
});

test("object types form a registry and derive mass from density", () => {
  assert.match(objectTypes, /export const OBJECT_TYPES/);
  assert.match(objectTypes, /return type\.density \* radius \* radius/); // massFor
  for (const id of ["asteroid", "rocky", "gasGiant", "star", "whiteDwarf", "neutronStar", "blackHole"]) {
    assert.match(objectTypes, new RegExp(`id: "${id}"`));
  }
});

test("creation is wired to the object-type registry, not hardcoded presets", () => {
  assert.match(main, /massFor\(type, radius\)/);
  assert.doesNotMatch(main, /selectedCreationPreset/);
  assert.doesNotMatch(main, /preset-planet|preset-blackhole/);
});
