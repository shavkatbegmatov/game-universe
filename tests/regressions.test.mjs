import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shaders = readFileSync(new URL("../src/gpu-shaders.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
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
