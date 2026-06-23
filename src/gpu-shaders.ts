export const TEXTURE_SIZE = 64;
export const PARTICLE_COUNT = TEXTURE_SIZE * TEXTURE_SIZE;
export const MAIN_BODY_COUNT = 256;
export const FRAGMENTS_PER_EVENT = 15;

const shaderConstants = `
  #define TEX_SIZE ${TEXTURE_SIZE}.0
  #define PARTICLE_COUNT ${PARTICLE_COUNT}
  #define MAIN_BODY_COUNT ${MAIN_BODY_COUNT}.0
  #define FRAGMENTS_PER_EVENT ${FRAGMENTS_PER_EVENT}.0
  #define G 9500.0
  #define SOFTENING 12.0
  // Базовая (эталонная) поверхностная плотность каменистого тела: mass = MASS_DENSITY * r^2.
  // Реальная плотность каждого тела хранится неявно как mass / r^2 и может отличаться
  // (рыхлый газ -> плотная планета -> сверхплотная чёрная дыра). См. bodyDensity().
  #define MASS_DENSITY 0.15
  // При таком и большем отношении масс крупное тело безусловно поглощает мелкое.
  #define MERGE_RATIO 2.75
  // Масштаб скорости разлёта при дальнейшем крошении осколка (НЕ порог столкновения —
  // пороги исхода теперь физические, через скорость убегания, см. collisionRegime()).
  #define FRAGMENT_SPEED 62.0
  // Упругость отскока. Крупные тела — умеренно упруги; столкновения с участием
  // осколков — сильно неупругие: энергия рассеивается, поэтому скопление осколков
  // НЕ может самопроизвольно набрать скорость «из пустоты» (нет источника энергии).
  #define RESTITUTION 0.45
  #define RESTITUTION_FRAGMENT 0.15
  // Доля устранения перекрытия за кадр (Baumgarte): мягкая позиционная коррекция,
  // которая не вбрасывает скорость в систему.
  #define POSITION_CORRECTION 0.5

  // --- Реалистичные режимы столкновения (зависят от массы, скорости И плотности) ---
  // Все пороги заданы относительно ВЗАИМНОЙ СКОРОСТИ УБЕГАНИЯ контакта (vEsc) —
  // это переводит «магические» скорости в физический критерий гравитационной связи.
  // Ниже этой доли vEsc контакт считается мягким (рикошет жёстких тел, можно
  // складывать тела в кучу — песочница не схлопывается мгновенно).
  #define BOUNCE_ESC_FACTOR 0.5
  // Выше этой доли vEsc удар гиперболический: лобовой -> катастрофа, скользящий -> «hit-and-run».
  #define DISRUPT_ESC_FACTOR 1.6
  // Во сколько раз одно тело плотнее, чтобы безусловно поглотить другое: так чёрная
  // дыра / нейтронная звезда (структурно неразрушимы) ВСЕГДА аккрецируют — без хака.
  #define DENSITY_DOMINANCE 12.0
  // Насколько удар «в лоб» (|cos| между относительной скоростью и нормалью контакта)
  // нужен для катастрофического разрушения, а не рикошета по касательной.
  #define HEADON_COS 0.5

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

  // Поверхностная плотность тела (mass / radius^2). Пропорциональна реальной
  // плотности и именно она отличает пыль/планету/звезду/нейтронную звезду/чёрную
  // дыру друг от друга. Радиус -> производная величина: r = sqrt(mass / density).
  float bodyDensity(vec4 body) {
    return body.z / max(body.w * body.w, 1e-6);
  }

  // Единая модель исхода столкновения двух тел. СИММЕТРИЧНА по (a, b): позиционный,
  // скоростной и фрагментный проходы вызывают ОДНУ функцию -> всегда одно решение,
  // поэтому масса и импульс не могут «разойтись» между проходами. Коды исхода:
  //   0.0 — рикошет (мягкий контакт жёстких тел / скользящий «hit-and-run» / нет слотов)
  //   1.0 — слияние/аккреция (доминирует плотность или масса, либо связаны при средней энергии)
  //   2.0 — катастрофическое разрушение (оба основных тела дробятся на осколки)
  //   3.0 — крошение осколка на месте (в паре участвует осколок)
  float collisionRegime(vec4 posA, vec4 velA, vec4 posB, vec4 velB, bool bothMain, bool slotsFree) {
    float totalMass = posA.z + posB.z;
    float kA = bodyDensity(posA);
    float kB = bodyDensity(posB);
    float densityRatio = max(kA, kB) / max(min(kA, kB), 1e-6);
    float massRatio = max(posA.z, posB.z) / max(min(posA.z, posB.z), 1e-6);
    vec2 relVel = velB.xy - velA.xy;
    float relSpeed = length(relVel);
    // Взаимная скорость убегания на контакте — реальный критерий связанности.
    float vEsc = sqrt(2.0 * G * totalMass / max(posA.w + posB.w, SOFTENING));

    // Сверхплотное тело (чёрная дыра, нейтронная звезда) поглощает любое другое.
    if (densityRatio >= DENSITY_DOMINANCE) return 1.0;
    // Сильно неравные массы — крупное тело поглощает мелкое (аккреция/кратеринг).
    if (massRatio >= MERGE_RATIO) return 1.0;
    // Быстрый, гиперболический удар сопоставимых масс.
    if (relSpeed >= vEsc * DISRUPT_ESC_FACTOR) {
      vec2 normal = safeDir(posB.xy - posA.xy, vec2(1.0, 0.0));
      float headOn = abs(dot(safeDir(relVel, normal), normal));
      if (headOn >= HEADON_COS) {
        if (bothMain) return slotsFree ? 2.0 : 0.0;  // в лоб: разрушение, если есть слоты, иначе рикошет
        return 3.0;                                   // в паре осколок -> он крошится на месте
      }
      return 0.0;  // скользящий быстрый проход — «hit-and-run», рикошет (оба уцелели)
    }
    // Мягкий контакт жёстких тел — рикошет (позволяет складывать тела, песочница живёт).
    if (relSpeed < vEsc * BOUNCE_ESC_FACTOR) return 0.0;
    // Гравитационно связаны при средней энергии — аккреция/слияние.
    return 1.0;
  }

  // Кто «выживает» при слиянии. При доминировании плотности — более плотное тело
  // (чёрная дыра поглощает даже более массивное рыхлое облако), иначе — более
  // массивное. Ничьи решаются по индексу, чтобы оба прохода выбрали ОДНО тело.
  bool survivorIsSelf(float selfIndex, float partnerIndex, vec4 posSelf, vec4 posOther) {
    float kS = bodyDensity(posSelf);
    float kO = bodyDensity(posOther);
    float densityRatio = max(kS, kO) / max(min(kS, kO), 1e-6);
    if (densityRatio >= DENSITY_DOMINANCE) {
      if (abs(kS - kO) > 1e-6) return kS > kO;
      return selfIndex < partnerIndex;
    }
    if (abs(posSelf.z - posOther.z) > 0.0001) return posSelf.z > posOther.z;
    return selfIndex < partnerIndex;
  }

  // Гравитация рассчитывается от всех активных тел (PARTICLE_COUNT)
  vec2 gravityAcceleration(float selfIndex, vec2 selfPosition) {
    vec2 acceleration = vec2(0.0);
    for (int j = 0; j < PARTICLE_COUNT; j++) {
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
    
    // Столкновения проверяются со всеми активными телами (PARTICLE_COUNT).
    for (int j = 0; j < PARTICLE_COUNT; j++) {
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
    float relativeSpeed = length(otherVelocity.xy - parentVelocity.xy);
    float totalMass = parentPosition.z + otherPosition.z;
    float energy = 0.5 * totalMass * relativeSpeed * relativeSpeed;
    float count = fragmentCount(energy, totalMass);
    bool slotsFree = fragmentSlotsFree(parentIndex, count);
    // Осколки рождаются ТОЛЬКО при катастрофическом разрушении (режим 2.0). Та же
    // функция вызывается в main(), поэтому решение совпадает и масса сохраняется.
    float regime = collisionRegime(parentPosition, parentVelocity, otherPosition, otherVelocity, true, slotsFree);
    if (regime < 1.5 || regime > 2.5) return -1.0;
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
              // Плотность осколков — материал исходных тел (сохраняем суммарную площадь):
              // куски той же «породы», а не размазанные под глобальную плотность.
              float kFrag = totalMass / max(parentPosition.w * parentPosition.w + otherPosition.w * otherPosition.w, 1e-6);
              float radius = sqrt(mass / kFrag);
              // Кольцо разлёта растёт с числом осколков -> без взаимного перекрытия.
              float averageRadius = sqrt((totalMass / count) / kFrag);
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
      bool bothMain = selfIndex < MAIN_BODY_COUNT && partnerIndex < MAIN_BODY_COUNT;
      float totalMass = positionData.z + otherPosition.z;
      float relativeSpeed = length(otherVelocity.xy - velocityData.xy);
      float collisionEnergy = 0.5 * totalMass * relativeSpeed * relativeSpeed;
      float collisionFragments = fragmentCount(collisionEnergy, totalMass);
      // Слоты под осколки нужны только когда дробятся ДВА основных тела (блок меньшего индекса).
      bool slotsFree = bothMain ? fragmentSlotsFree(min(selfIndex, partnerIndex), collisionFragments) : true;
      float regime = collisionRegime(positionData, velocityData, otherPosition, otherVelocity, bothMain, slotsFree);

      if (regime > 1.5 && regime < 2.5) {
        // Катастрофа: оба основных тела исчезают, вся масса уходит в осколки.
        gl_FragColor = vec4(0.0);
        return;
      }
      if (regime > 2.5) {
        // Крошение осколка (бесконечная рекурсия): масса и радиус падают, но плотность
        // осколка сохраняется (r ~ sqrt(mass) при той же плотности), а не размазывается.
        float newMass = positionData.z * 0.45;
        float newRadius = sqrt(newMass / bodyDensity(positionData));
        gl_FragColor = vec4(positionData.xy, newMass, newRadius);
        return;
      }
      if (regime > 0.5) {
        // Слияние/аккреция: масса переходит к выжившему, радиус сохраняет ЕГО плотность.
        // Поэтому чёрная дыра остаётся компактной, а не раздувается в гигантский пузырь.
        if (!survivorIsSelf(selfIndex, partnerIndex, positionData, otherPosition)) {
          gl_FragColor = vec4(0.0);
          return;
        }
        vec2 center = (positionData.xy * positionData.z + otherPosition.xy * otherPosition.z) / totalMass;
        float kSurvivor = bodyDensity(positionData);
        gl_FragColor = vec4(center, totalMass, sqrt(totalMass / kSurvivor));
        return;
      }
      // Рикошет: мягко разводим перекрытие (доля POSITION_CORRECTION, без вброса
      // скорости). Смещение обратно массе — лёгкое тело отходит сильнее.
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
// в мировых координатах, но сетка always покрывает экран при панорамировании).
export const gridVertexShader = `
  uniform sampler2D u_positions;
  uniform float u_warp;
  uniform vec2 u_gridOffset;
  uniform float u_gridStep;
  varying float vPotential;
  vec2 uvForIndex(float index) {
    return (vec2(mod(index, ${TEXTURE_SIZE}.0), floor(index / ${TEXTURE_SIZE}.0)) + 0.5) / ${TEXTURE_SIZE}.0;
  }
  void main() {
    vec2 world = position.xy * u_gridStep + u_gridOffset;   // мировая позиция узла
    vec2 pull = vec2(0.0);
    float potential = 0.0;
    for (int i = 0; i < ${PARTICLE_COUNT}; i++) {
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

    // Накопление гравитации и проверка столкновения со всеми активными телами (PARTICLE_COUNT)
    for (int j = 0; j < PARTICLE_COUNT; j++) {
      float otherIndex = float(j);
      if (abs(otherIndex - selfIndex) < 0.5) continue;
      vec4 otherPosition = texture2D(texturePosition, uvForIndex(otherIndex));
      if (otherPosition.z <= 0.0) continue;
      vec2 delta = otherPosition.xy - positionData.xy;

      // Накопление гравитации
      float distanceSq = dot(delta, delta) + SOFTENING * SOFTENING;
      float inverseDistance = inversesqrt(distanceSq);
      acceleration += G * otherPosition.z * delta * inverseDistance * inverseDistance * inverseDistance;

      // Проверка столкновения
      if (selfSettled) {
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
      bool bothMain = selfIndex < MAIN_BODY_COUNT && partnerIndex < MAIN_BODY_COUNT;
      float totalMass = positionData.z + otherPosition.z;
      float relativeSpeed = length(otherVelocity.xy - velocityData.xy);
      float collisionEnergy = 0.5 * totalMass * relativeSpeed * relativeSpeed;
      float collisionFragments = fragmentCount(collisionEnergy, totalMass);
      bool slotsFree = bothMain ? fragmentSlotsFree(min(selfIndex, partnerIndex), collisionFragments) : true;
      float regime = collisionRegime(positionData, velocityData, otherPosition, otherVelocity, bothMain, slotsFree);

      if (regime > 1.5 && regime < 2.5) {
        // Катастрофа: основное тело исчезает (его масса учтена осколками).
        gl_FragColor = vec4(0.0);
        return;
      }
      if (regime > 2.5) {
        // Крошение осколка: высокоскоростной отскок в сторону сброса энергии.
        vec2 centerVelocity = (velocityData.xy * positionData.z + otherVelocity.xy * otherPosition.z) / totalMass;
        vec2 impactNormal = safeDir(otherPosition.xy - positionData.xy, vec2(1.0, 0.0));
        float seed = hash11(selfIndex * 3.7 + u_time * 1.3);
        float angle = atan(impactNormal.y, impactNormal.x) + 1.57 + (seed - 0.5) * 2.0;
        vec2 burst = vec2(cos(angle), sin(angle)) * (FRAGMENT_SPEED * 0.35 * (0.6 + 0.8 * seed));
        gl_FragColor = vec4(centerVelocity + burst, 12.0, 1.35); // сброс жизни
        return;
      }
      if (regime > 0.5) {
        // Слияние сохраняет импульс: масса-взвешенная скорость переходит к выжившему.
        if (!survivorIsSelf(selfIndex, partnerIndex, positionData, otherPosition)) {
          gl_FragColor = vec4(0.0);
          return;
        }
        velocityData.xy = (velocityData.xy * positionData.z + otherVelocity.xy * otherPosition.z) / totalMass;
      } else {
        // Рикошет: неупругий импульс по нормали + тангенциальное трение для реализма.
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
