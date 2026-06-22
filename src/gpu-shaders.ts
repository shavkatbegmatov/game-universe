export const TEXTURE_SIZE = 128;
export const PARTICLE_COUNT = TEXTURE_SIZE * TEXTURE_SIZE;
export const MAIN_BODY_COUNT = 512;
export const FRAGMENTS_PER_EVENT = 30;

const shaderConstants = `
  #define TEX_SIZE ${TEXTURE_SIZE}.0
  #define PARTICLE_COUNT ${PARTICLE_COUNT}
  #define MAIN_BODY_COUNT ${MAIN_BODY_COUNT}.0
  #define FRAGMENTS_PER_EVENT ${FRAGMENTS_PER_EVENT}.0
  #define G 9500.0
  #define SOFTENING 12.0
  #define MASS_DENSITY 0.15
  #define MERGE_RATIO 2.75
  #define FRAGMENT_SPEED 62.0
  // Упругость отскока. Крупные тела — умеренно упруги; столкновения с участием
  // осколков — сильно неупругие: энергия рассеивается, поэтому скопление осколков
  // НЕ может самопроизвольно набрать скорость «из пустоты» (нет источника энергии).
  #define RESTITUTION 0.45
  #define RESTITUTION_FRAGMENT 0.15
  // Доля устранения перекрытия за кадр (Baumgarte): мягкая позиционная коррекция,
  // которая не вбрасывает скорость в систему.
  #define POSITION_CORRECTION 0.5

  uniform float u_dt;
  uniform float u_time;
  uniform float u_phase;
  uniform float u_mutationOnly;
  uniform float u_injectSlot;
  uniform float u_deleteSlot;
  uniform vec4 u_injectPosition;
  uniform vec4 u_injectVelocity;

  vec2 uvForIndex(float index) {
    return (vec2(mod(index, TEX_SIZE), floor(index / TEX_SIZE)) + 0.5) / TEX_SIZE;
  }

  float indexForFragment() {
    return floor(gl_FragCoord.y) * TEX_SIZE + floor(gl_FragCoord.x);
  }

  float hash11(float value) {
    return fract(sin(value * 12.9898 + 78.233) * 43758.5453);
  }

  // Безопасная нормализация: при нулевом векторе (тела точно совпали) возвращает
  // запасное направление вместо NaN, который иначе заразил бы всю симуляцию.
  vec2 safeDir(vec2 v, vec2 fallback) {
    float len = length(v);
    return len > 0.0001 ? v / len : fallback;
  }

  // Оптимизация: гравитация рассчитывается только от массивных основных тел (MAIN_BODY_COUNT)
  vec2 gravityAcceleration(float selfIndex, vec2 selfPosition) {
    vec2 acceleration = vec2(0.0);
    for (int j = 0; j < int(MAIN_BODY_COUNT); j++) {
      float otherIndex = float(j);
      if (abs(otherIndex - selfIndex) < 0.5) continue;
      vec4 otherPosition = texture2D(texturePosition, uvForIndex(otherIndex));
      if (otherPosition.z <= 0.0) continue;
      vec2 delta = otherPosition.xy - selfPosition;
      float distanceSq = dot(delta, delta) + SOFTENING * SOFTENING;
      float inverseDistance = inversesqrt(distanceSq);
      acceleration += G * otherPosition.z * delta * inverseDistance * inverseDistance * inverseDistance;
    }
    return acceleration;
  }

  // Число осколков зависит и от массы (крупные тела дробятся на большее число
  // кусков), и от энергии удара — а не фиксировано и не случайно.
  float fragmentCount(float energy, float totalMass) {
    float byMass = totalMass / 8.0;
    float byEnergy = sqrt(max(0.0, energy)) / 42.0;
    return clamp(floor(3.0 + byMass + byEnergy), 4.0, FRAGMENTS_PER_EVENT);
  }

  // Вес осколка (его доля массы). Куски получаются разного размера, но детерминированно.
  float fragmentWeight(float fragmentSlot) {
    return 0.55 + 0.9 * hash11(fragmentSlot * 2.91 + u_time * 1.3);
  }

  // Сумма весов всех осколков события: нужна, чтобы нормировать массы и
  // гарантировать, что суммарная масса осколков точно равна массе исходных тел.
  float fragmentWeightSum(float parentIndex, float count) {
    float sum = 0.0;
    for (int i = 0; i < ${FRAGMENTS_PER_EVENT}; i++) {
      if (float(i) >= count) break;
      float fragmentSlot = MAIN_BODY_COUNT + parentIndex * FRAGMENTS_PER_EVENT + float(i);
      sum += fragmentWeight(fragmentSlot);
    }
    return sum;
  }

  // Скорость разлёта осколка ОТНОСИТЕЛЬНО центра масс (без самой скорости ЦМ).
  // Направление вдоль оси удара с разбросом, асимметрией и передачей импульса.
  vec2 fragmentBurst(float fragmentSlot, float ordinal, float count, float burstSpeed,
                     vec2 impactNormal, float impactAngle, float impactSpeed) {
    float seedA = hash11(fragmentSlot * 1.37 + u_time * 0.7);
    float seedB = hash11(fragmentSlot * 2.91 + u_time * 1.3);
    float seedC = hash11(fragmentSlot * 4.13 + u_time * 0.5);
    float spread = 6.28318530718 * (ordinal + 0.5 + 0.45 * (seedA - 0.5)) / count;
    vec2 direction = vec2(cos(impactAngle + spread), sin(impactAngle + spread));
    float forwardBias = 0.55 + 0.45 * dot(direction, impactNormal);
    float speed = burstSpeed * forwardBias * (0.6 + 0.8 * seedB);
    return direction * speed + impactNormal * impactSpeed * 0.12 * seedC;
  }

  // Импульс разлёта осколков в системе ЦМ: sum(m_i * burst_i). Вычитая его долю из
  // скорости каждого осколка, гарантируем sum(m_i * v_i) = M * v_цм — импульс
  // при дроблении сохраняется точно (осколки не создают импульс «из пустоты»).
  vec2 fragmentBurstMomentum(float parentIndex, float count, float totalMass, float weightSum,
                             float burstSpeed, vec2 impactNormal, float impactAngle, float impactSpeed) {
    vec2 net = vec2(0.0);
    for (int i = 0; i < ${FRAGMENTS_PER_EVENT}; i++) {
      if (float(i) >= count) break;
      float fragmentSlot = MAIN_BODY_COUNT + parentIndex * FRAGMENTS_PER_EVENT + float(i);
      float mass = totalMass * fragmentWeight(fragmentSlot) / weightSum;
      net += mass * fragmentBurst(fragmentSlot, float(i), count, burstSpeed, impactNormal, impactAngle, impactSpeed);
    }
    return net;
  }

  // Глубочайшее проникновение: партнёр, с которым перекрытие максимально (а не
  // первый попавшийся по индексу). Детерминированно — это нужно для взаимной проверки.
  float deepestPartner(float selfIndex, vec4 selfPosition, vec4 selfVelocity) {
    if (selfVelocity.w > 1.0001) return -1.0; // тело ещё «оседает» после рождения
    float partner = -1.0;
    float deepest = 0.0;
    int limit = selfIndex < MAIN_BODY_COUNT ? PARTICLE_COUNT : int(MAIN_BODY_COUNT);
    for (int j = 0; j < PARTICLE_COUNT; j++) {
      if (j >= limit) break;
      float otherIndex = float(j);
      if (abs(otherIndex - selfIndex) < 0.5) continue;
      vec4 otherPosition = texture2D(texturePosition, uvForIndex(otherIndex));
      if (otherPosition.z <= 0.0) continue;
      vec4 otherVelocity = texture2D(textureVelocity, uvForIndex(otherIndex));
      if (otherVelocity.w > 1.0001) continue;
      float combinedRadius = selfPosition.w + otherPosition.w;
      vec2 delta = otherPosition.xy - selfPosition.xy;
      if (abs(delta.x) > combinedRadius || abs(delta.y) > combinedRadius) continue;
      float distSq = dot(delta, delta);
      if (distSq >= combinedRadius * combinedRadius) continue;
      float penetration = combinedRadius - sqrt(distSq);
      if (penetration > deepest + 1e-4) {
        deepest = penetration;
        partner = otherIndex;
      }
    }
    return partner;
  }

  // Взаимность: partnerIndex тоже считает selfIndex своим глубочайшим партнёром.
  // Сталкиваются ТОЛЬКО взаимные пары — это даёт симметричный импульс (3-й закон
  // Ньютона) и исключает потерю массы, когда в кучу налезают три и более тел.
  bool isMutualPair(float selfIndex, float partnerIndex) {
    vec4 partnerPosition = texture2D(texturePosition, uvForIndex(partnerIndex));
    vec4 partnerVelocity = texture2D(textureVelocity, uvForIndex(partnerIndex));
    return abs(deepestPartner(partnerIndex, partnerPosition, partnerVelocity) - selfIndex) < 0.5;
  }

  // Все слоты, которые потребуются событию, должны быть свободны. Иначе исходные
  // тела нельзя уничтожать: частично созданный каскад нарушил бы сохранение массы.
  bool fragmentSlotsFree(float parentIndex, float count) {
    for (int i = 0; i < ${FRAGMENTS_PER_EVENT}; i++) {
      if (float(i) >= count) break;
      float fragmentSlot = MAIN_BODY_COUNT + parentIndex * FRAGMENTS_PER_EVENT + float(i);
      if (texture2D(texturePosition, uvForIndex(fragmentSlot)).z > 0.0) return false;
    }
    return true;
  }

  // Партнёр события дробления для блока осколков родителя parentIndex. Возвращает
  // индекс налетевшего тела ТОЛЬКО если: пара взаимна, энергия удара достаточна,
  // массы сопоставимы, оба — основные тела, есть свободные слоты, и parentIndex —
  // МЕНЬШИЙ из двух (осколки всегда рождаются в блоке меньшего индекса). Эти же
  // условия проверяются при дроблении в main(), поэтому масса всегда сохраняется.
  float shatterPartner(float parentIndex, vec4 parentPosition, vec4 parentVelocity) {
    if (parentPosition.z <= 0.0) return -1.0;
    float partner = deepestPartner(parentIndex, parentPosition, parentVelocity);
    if (partner < 0.0 || partner < parentIndex || partner >= MAIN_BODY_COUNT) return -1.0;
    if (!isMutualPair(parentIndex, partner)) return -1.0;
    vec4 otherPosition = texture2D(texturePosition, uvForIndex(partner));
    vec4 otherVelocity = texture2D(textureVelocity, uvForIndex(partner));
    float ratio = max(parentPosition.z, otherPosition.z) / min(parentPosition.z, otherPosition.z);
    float relativeSpeed = length(otherVelocity.xy - parentVelocity.xy);
    if (ratio >= MERGE_RATIO || relativeSpeed < FRAGMENT_SPEED) return -1.0;
    float totalMass = parentPosition.z + otherPosition.z;
    float energy = 0.5 * totalMass * relativeSpeed * relativeSpeed;
    float count = fragmentCount(energy, totalMass);
    if (!fragmentSlotsFree(parentIndex, count)) return -1.0;
    return partner;
  }
`;

export const positionShader = `
  ${shaderConstants}

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    float selfIndex = indexForFragment();
    vec4 positionData = texture2D(texturePosition, uv);
    vec4 velocityData = texture2D(textureVelocity, uv);

    // Вторая фаза Verlet обновляет только скорость по уже вычисленной позиции.
    if (u_phase > 0.5) {
      gl_FragColor = positionData;
      return;
    }

    if (abs(selfIndex - u_deleteSlot) < 0.5) {
      gl_FragColor = vec4(0.0);
      return;
    }
    if (abs(selfIndex - u_injectSlot) < 0.5) {
      gl_FragColor = u_injectPosition;
      return;
    }
    if (u_mutationOnly > 0.5) {
      gl_FragColor = positionData;
      return;
    }

    if (positionData.z <= 0.0) {
      if (selfIndex >= MAIN_BODY_COUNT) {
        float fragmentLocalIndex = selfIndex - MAIN_BODY_COUNT;
        float parentIndex = floor(fragmentLocalIndex / FRAGMENTS_PER_EVENT);
        float ordinal = mod(fragmentLocalIndex, FRAGMENTS_PER_EVENT);
        if (parentIndex < MAIN_BODY_COUNT) {
          vec4 parentPosition = texture2D(texturePosition, uvForIndex(parentIndex));
          vec4 parentVelocity = texture2D(textureVelocity, uvForIndex(parentIndex));
          float partnerIndex = shatterPartner(parentIndex, parentPosition, parentVelocity);
          if (partnerIndex >= 0.0) {
            vec4 otherPosition = texture2D(texturePosition, uvForIndex(partnerIndex));
            vec4 otherVelocity = texture2D(textureVelocity, uvForIndex(partnerIndex));
            float totalMass = parentPosition.z + otherPosition.z;
            float relativeSpeed = length(otherVelocity.xy - parentVelocity.xy);
            float energy = 0.5 * totalMass * relativeSpeed * relativeSpeed;
            float count = fragmentCount(energy, totalMass);
            if (ordinal < count) {
              float seedA = hash11(selfIndex * 1.37 + u_time * 0.7);
              // Ось удара: осколки разлетаются вдоль неё, а не идеальным кругом.
              vec2 impactNormal = safeDir(otherPosition.xy - parentPosition.xy, vec2(1.0, 0.0));
              float impactAngle = atan(impactNormal.y, impactNormal.x);
              float spread = 6.28318530718 * (ordinal + 0.5 + 0.45 * (seedA - 0.5)) / count;
              float angle = impactAngle + spread;
              vec2 direction = vec2(cos(angle), sin(angle));
              // Масса нормирована весом: сумма масс осколков точно равна исходной массе.
              float mass = totalMass * fragmentWeight(selfIndex) / fragmentWeightSum(parentIndex, count);
              float radius = sqrt(mass / MASS_DENSITY);
              // Кольцо разлёта растёт с числом осколков -> без взаимного перекрытия.
              float averageRadius = sqrt((totalMass / count) / MASS_DENSITY);
              float ringRadius = (parentPosition.w + otherPosition.w) * 0.4 + count * averageRadius * 0.42;
              vec2 center = (parentPosition.xy * parentPosition.z + otherPosition.xy * otherPosition.z) / totalMass;
              gl_FragColor = vec4(center + direction * ringRadius, mass, radius);
              return;
            }
          }
        }
      }
      gl_FragColor = vec4(0.0);
      return;
    }

    if (selfIndex >= MAIN_BODY_COUNT && velocityData.z > 0.0 && velocityData.z <= u_dt) {
      gl_FragColor = vec4(0.0);
      return;
    }

    float partnerIndex = deepestPartner(selfIndex, positionData, velocityData);
    if (partnerIndex >= 0.0 && isMutualPair(selfIndex, partnerIndex)) {
      vec4 otherPosition = texture2D(texturePosition, uvForIndex(partnerIndex));
      vec4 otherVelocity = texture2D(textureVelocity, uvForIndex(partnerIndex));
      float ratio = max(positionData.z, otherPosition.z) / min(positionData.z, otherPosition.z);
      float relativeSpeed = length(otherVelocity.xy - velocityData.xy);
      bool bothMain = selfIndex < MAIN_BODY_COUNT && partnerIndex < MAIN_BODY_COUNT;
      bool survivor = positionData.z > otherPosition.z ||
        (abs(positionData.z - otherPosition.z) < 0.0001 && selfIndex < partnerIndex);
      // Дробление возможно только когда есть свободные слоты под осколки (в блоке
      // меньшего индекса). Те же условия — в фрагментном блоке выше, поэтому либо оба
      // тела превращаются в осколки, либо масса уходит в слияние — но не пропадает.
      float collisionMass = positionData.z + otherPosition.z;
      float collisionEnergy = 0.5 * collisionMass * relativeSpeed * relativeSpeed;
      float collisionFragments = fragmentCount(collisionEnergy, collisionMass);
      bool doShatter = ratio < MERGE_RATIO && relativeSpeed >= FRAGMENT_SPEED && bothMain
        && fragmentSlotsFree(min(selfIndex, partnerIndex), collisionFragments);
      if (doShatter) {
        gl_FragColor = vec4(0.0);
        return;
      }
      if (ratio >= MERGE_RATIO || relativeSpeed >= FRAGMENT_SPEED) {
        // Слияние: масса всегда переходит к выжившему, ничто не исчезает бесследно.
        if (!survivor) {
          gl_FragColor = vec4(0.0);
          return;
        }
        float totalMass = positionData.z + otherPosition.z;
        vec2 center = (positionData.xy * positionData.z + otherPosition.xy * otherPosition.z) / totalMass;
        gl_FragColor = vec4(center, totalMass, sqrt(totalMass / MASS_DENSITY));
        return;
      }
      // Низкоэнергетический контакт: мягко разводим перекрытие (доля POSITION_CORRECTION,
      // без вброса скорости). Смещение обратно массе — лёгкое тело отходит сильнее.
      vec2 delta = otherPosition.xy - positionData.xy;
      float distanceToOther = max(length(delta), 0.001);
      vec2 fallback = selfIndex < partnerIndex ? vec2(1.0, 0.0) : vec2(-1.0, 0.0);
      vec2 normal = safeDir(delta, fallback);
      float overlap = max(0.0, positionData.w + otherPosition.w - distanceToOther);
      float ownShare = otherPosition.z / (positionData.z + otherPosition.z);
      positionData.xy -= normal * overlap * ownShare * POSITION_CORRECTION;
    }

    // Velocity Verlet: x(t+dt) = x + v*dt + 1/2*a(t)*dt^2.
    vec2 acceleration = gravityAcceleration(selfIndex, positionData.xy);
    positionData.xy += velocityData.xy * u_dt + 0.5 * acceleration * u_dt * u_dt;
    gl_FragColor = positionData;
  }
`;

export const fullscreenVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Сетка «ткани пространства-времени». u_gridOffset привязывает её к камере (узлы
// в мировых координатах, но сетка всегда покрывает экран при панорамировании).
export const gridVertexShader = `
  uniform sampler2D u_positions;
  uniform float u_warp;
  uniform vec2 u_gridOffset;
  varying float vPotential;
  vec2 uvForIndex(float index) {
    return (vec2(mod(index, ${TEXTURE_SIZE}.0), floor(index / ${TEXTURE_SIZE}.0)) + 0.5) / ${TEXTURE_SIZE}.0;
  }
  void main() {
    vec2 world = position.xy + u_gridOffset;   // мировая позиция узла
    vec2 pull = vec2(0.0);
    float potential = 0.0;
    for (int i = 0; i < ${MAIN_BODY_COUNT}; i++) {
      vec4 body = texture2D(u_positions, uvForIndex(float(i)));
      if (body.z <= 0.0) continue;
      vec2 delta = body.xy - world;            // от узла К телу
      float dist = length(delta);
      // «Яма» масштабируется с массой: тяжёлое тело искривляет ЗАМЕТНО сильнее и
      // шире (нет общего потолка), но насыщение у самого тела не даёт узлам схлопнуться.
      float depth = body.z * u_warp;
      float pullMag = depth / (dist + depth * 0.02 + 50.0);
      pullMag = min(pullMag, dist * 0.8);      // узел не перепрыгивает тело
      pull += (delta / (dist + 0.001)) * pullMag;
      potential += body.z / (dist + 60.0);
    }
    vPotential = potential;
    vec2 displaced = world + pull;
    // y инвертируется, как и у тел (камера смотрит из -y).
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced.x, -displaced.y, 0.0, 1.0);
  }
`;

export const gridFragmentShader = `
  precision mediump float;
  uniform vec3 u_color;
  varying float vPotential;
  void main() {
    // Серые линии на чёрном космосе; ярче там, где сильнее искривление.
    // Базовая непрозрачность держит сетку видимой ВЕЗДЕ.
    float intensity = clamp(vPotential * 0.05, 0.0, 1.0);
    gl_FragColor = vec4(u_color, 0.38 + intensity * 0.42);
  }
`;

// Сдвигает накопленный след в новые экранные координаты камеры (re-projection),
// затем гасит его на коэффициент u_fade, чтобы получались затухающие линии-хвосты.
export const trailFadeShader = `
  precision highp float;
  uniform sampler2D u_prevTrail;
  uniform float u_fade;
  uniform vec2 u_resolution;
  uniform vec3 u_cameraCurrent;
  uniform vec3 u_cameraPrevious;
  varying vec2 vUv;

  void main() {
    // Текущий UV -> мировые координаты (камера этого кадра).
    float worldX = (vUv.x - 0.5) * u_resolution.x / u_cameraCurrent.z + u_cameraCurrent.x;
    float worldY = u_cameraCurrent.y - (vUv.y - 0.5) * u_resolution.y / u_cameraCurrent.z;
    // Мировые координаты -> UV прошлого кадра (камера прошлого кадра).
    vec2 previousUv = vec2(
      (worldX - u_cameraPrevious.x) * u_cameraPrevious.z / u_resolution.x + 0.5,
      (u_cameraPrevious.y - worldY) * u_cameraPrevious.z / u_resolution.y + 0.5
    );
    vec4 previous = texture2D(u_prevTrail, previousUv);
    float inside = step(0.0, previousUv.x) * step(previousUv.x, 1.0)
                 * step(0.0, previousUv.y) * step(previousUv.y, 1.0);
    gl_FragColor = previous * (u_fade * inside);
  }
`;

export const trailCompositeShader = `
  precision highp float;
  uniform sampler2D u_trail;
  uniform float u_intensity;
  varying vec2 vUv;

  void main() {
    vec3 trail = texture2D(u_trail, vUv).rgb;
    gl_FragColor = vec4(trail * u_intensity, 1.0);
  }
`;

export const velocityShader = `
  ${shaderConstants}

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    float selfIndex = indexForFragment();
    vec4 positionData = texture2D(texturePosition, uv);
    vec4 velocityData = texture2D(textureVelocity, uv);

    // Вторая половина шага Verlet использует ускорение в новой позиции. События,
    // столкновения и lifecycle выполняются только в первой фазе.
    if (u_phase > 0.5) {
      if (positionData.z <= 0.0) {
        gl_FragColor = vec4(0.0);
        return;
      }
      velocityData.xy += 0.5 * gravityAcceleration(selfIndex, positionData.xy) * u_dt;
      gl_FragColor = velocityData;
      return;
    }

    if (abs(selfIndex - u_deleteSlot) < 0.5) {
      gl_FragColor = vec4(0.0);
      return;
    }
    if (abs(selfIndex - u_injectSlot) < 0.5) {
      gl_FragColor = u_injectVelocity;
      return;
    }
    if (u_mutationOnly > 0.5) {
      gl_FragColor = velocityData;
      return;
    }

    if (positionData.z <= 0.0) {
      if (selfIndex >= MAIN_BODY_COUNT) {
        float fragmentLocalIndex = selfIndex - MAIN_BODY_COUNT;
        float parentIndex = floor(fragmentLocalIndex / FRAGMENTS_PER_EVENT);
        float ordinal = mod(fragmentLocalIndex, FRAGMENTS_PER_EVENT);
        if (parentIndex < MAIN_BODY_COUNT) {
          vec4 parentPosition = texture2D(texturePosition, uvForIndex(parentIndex));
          vec4 parentVelocity = texture2D(textureVelocity, uvForIndex(parentIndex));
          float partnerIndex = shatterPartner(parentIndex, parentPosition, parentVelocity);
          if (partnerIndex >= 0.0) {
            vec4 otherPosition = texture2D(texturePosition, uvForIndex(partnerIndex));
            vec4 otherVelocity = texture2D(textureVelocity, uvForIndex(partnerIndex));
            float totalMass = parentPosition.z + otherPosition.z;
            vec2 relativeVelocity = otherVelocity.xy - parentVelocity.xy;
            float relativeSpeed = length(relativeVelocity);
            float energy = 0.5 * totalMass * relativeSpeed * relativeSpeed;
            float count = fragmentCount(energy, totalMass);
            if (ordinal < count) {
              // Скорость центра масс — сохраняется (инерция/импульс системы).
              vec2 centerVelocity = (parentVelocity.xy * parentPosition.z + otherVelocity.xy * otherPosition.z) / totalMass;
              vec2 impactNormal = safeDir(otherPosition.xy - parentPosition.xy, vec2(1.0, 0.0));
              float impactAngle = atan(impactNormal.y, impactNormal.x);
              float impactSpeed = abs(dot(relativeVelocity, impactNormal));
              float burstSpeed = sqrt(2.0 * energy * 0.30 / totalMass);
              float weightSum = fragmentWeightSum(parentIndex, count);
              vec2 burst = fragmentBurst(selfIndex, ordinal, count, burstSpeed, impactNormal, impactAngle, impactSpeed);
              // Вычитаем долю суммарного импульса разлёта: тогда sum(m_i*v_i)=M*v_цм
              // и импульс сохраняется точно (импульс не берётся «из пустоты»).
              vec2 burstMomentum = fragmentBurstMomentum(parentIndex, count, totalMass, weightSum, burstSpeed, impactNormal, impactAngle, impactSpeed);
              vec2 fragmentVelocity = centerVelocity + burst - burstMomentum / totalMass;
              float life = 10.0 + 5.0 * hash11(selfIndex * 5.17 + u_time * 0.9);
              gl_FragColor = vec4(fragmentVelocity, life, 1.35);
              return;
            }
          }
        }
      }
      gl_FragColor = vec4(0.0);
      return;
    }

    if (selfIndex >= MAIN_BODY_COUNT) {
      if (velocityData.z > 0.0 && velocityData.z <= u_dt) {
        gl_FragColor = vec4(0.0);
        return;
      }
      velocityData.z = max(0.0, velocityData.z - u_dt);
      // Короткая защита только что родившегося осколка от мгновенных слияний.
      velocityData.w = max(1.0, velocityData.w - u_dt);
    }

    vec2 acceleration = vec2(0.0);
    float partnerIndex = -1.0;
    float deepest = 0.0;
    bool selfSettled = velocityData.w <= 1.0001;

    // Оптимизация: осколки проверяют столкновения только с основными телами
    int collisionLimit = selfIndex < MAIN_BODY_COUNT ? PARTICLE_COUNT : int(MAIN_BODY_COUNT);
    // Гравитация учитывает только массивные основные тела
    int gravityLimit = int(MAIN_BODY_COUNT);

    for (int j = 0; j < PARTICLE_COUNT; j++) {
      if (j >= collisionLimit && j >= gravityLimit) break;
      float otherIndex = float(j);
      if (abs(otherIndex - selfIndex) < 0.5) continue;
      vec4 otherPosition = texture2D(texturePosition, uvForIndex(otherIndex));
      if (otherPosition.z <= 0.0) continue;
      vec2 delta = otherPosition.xy - positionData.xy;

      // Накопление гравитации (только от основных тел)
      if (j < gravityLimit) {
        float distanceSq = dot(delta, delta) + SOFTENING * SOFTENING;
        float inverseDistance = inversesqrt(distanceSq);
        acceleration += G * otherPosition.z * delta * inverseDistance * inverseDistance * inverseDistance;
      }

      // Проверка столкновения
      if (j < collisionLimit && selfSettled) {
        float combinedRadius = positionData.w + otherPosition.w;
        if (abs(delta.x) <= combinedRadius && abs(delta.y) <= combinedRadius) {
          float distSq = dot(delta, delta);
          if (distSq < combinedRadius * combinedRadius) {
            vec4 otherVel = texture2D(textureVelocity, uvForIndex(otherIndex));
            if (otherVel.w <= 1.0001) {
              float penetration = combinedRadius - sqrt(distSq);
              if (penetration > deepest + 1e-4) {
                deepest = penetration;
                partnerIndex = otherIndex;
              }
            }
          }
        }
      }
    }

    if (partnerIndex >= 0.0 && isMutualPair(selfIndex, partnerIndex)) {
      vec4 otherPosition = texture2D(texturePosition, uvForIndex(partnerIndex));
      vec4 otherVelocity = texture2D(textureVelocity, uvForIndex(partnerIndex));
      float ratio = max(positionData.z, otherPosition.z) / min(positionData.z, otherPosition.z);
      float relativeSpeed = length(otherVelocity.xy - velocityData.xy);
      bool bothMain = selfIndex < MAIN_BODY_COUNT && partnerIndex < MAIN_BODY_COUNT;
      bool survivor = positionData.z > otherPosition.z ||
        (abs(positionData.z - otherPosition.z) < 0.0001 && selfIndex < partnerIndex);
      float collisionMass = positionData.z + otherPosition.z;
      float collisionEnergy = 0.5 * collisionMass * relativeSpeed * relativeSpeed;
      float collisionFragments = fragmentCount(collisionEnergy, collisionMass);
      bool doShatter = ratio < MERGE_RATIO && relativeSpeed >= FRAGMENT_SPEED && bothMain
        && fragmentSlotsFree(min(selfIndex, partnerIndex), collisionFragments);
      if (doShatter) {
        gl_FragColor = vec4(0.0);
        return;
      }
      if (ratio >= MERGE_RATIO || relativeSpeed >= FRAGMENT_SPEED) {
        // Слияние сохраняет импульс: масса-взвешему скорость.
        if (!survivor) {
          gl_FragColor = vec4(0.0);
          return;
        }
        velocityData.xy = (velocityData.xy * positionData.z + otherVelocity.xy * otherPosition.z) /
          (positionData.z + otherPosition.z);
      } else {
        // Неупругий отскок с физическим импульсом + тангенциальное трение для реализма
        vec2 delta = otherPosition.xy - positionData.xy;
        vec2 fallback = selfIndex < partnerIndex ? vec2(1.0, 0.0) : vec2(-1.0, 0.0);
        vec2 normal = safeDir(delta, fallback);
        float normalSpeed = dot(otherVelocity.xy - velocityData.xy, normal);
        if (normalSpeed < 0.0) {
          float restitution = bothMain ? RESTITUTION : RESTITUTION_FRAGMENT;
          float impulse = -(1.0 + restitution) * normalSpeed / (1.0 / positionData.z + 1.0 / otherPosition.z);
          velocityData.xy -= impulse * normal / positionData.z;

          // Тангенциальное трение (физический сдвиг при контакте)
          vec2 tangent = vec2(-normal.y, normal.x);
          float tangentSpeed = dot(otherVelocity.xy - velocityData.xy, tangent);
          float friction = bothMain ? 0.38 : 0.18; // коэффициент трения
          float tangentImpulse = -tangentSpeed * friction / (1.0 / positionData.z + 1.0 / otherPosition.z);
          velocityData.xy -= tangentImpulse * tangent / positionData.z;
        }
      }
    }

    // Первая половина velocity Verlet; вторая выполняется после обновления позиции.
    velocityData.xy += 0.5 * acceleration * u_dt;
    gl_FragColor = velocityData;
  }
`;
