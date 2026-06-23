// Единый источник правды о типах небесных тел. Тип задаёт ПЛОТНОСТЬ (k = mass / r^2)
// и диапазон радиусов; масса выводится как mass = density * r^2. Плотности образуют
// монотонную «лестницу» — от рыхлого газового гиганта до сверхплотной чёрной дыры,
// поэтому тип тела можно восстановить из одной только плотности (см. classifyByDensity).
// Те же пороги band'ов продублированы в шейдере (gpu-engine.ts) для выбора внешнего вида.

export type ObjectTypeId =
  | "asteroid"
  | "rocky"
  | "gasGiant"
  | "star"
  | "whiteDwarf"
  | "neutronStar"
  | "blackHole";

export interface ObjectType {
  id: ObjectTypeId;
  /** Отображаемое имя (RU, как и остальной интерфейс). */
  name: string;
  /** Поверхностная плотность k = mass / r^2. */
  density: number;
  minRadius: number;
  maxRadius: number;
  defaultRadius: number;
  /** Цвет-акцент для палитры и точки в сайдбаре. */
  accent: string;
  /** Короткая подсказка о поведении в инспекторе. */
  hint: string;
}

// Пороги классификации по плотности. ДОЛЖНЫ совпадать с band'ами в шейдере.
export const DENSITY_BANDS = {
  gasGiant: 0.09, // k < 0.09        -> газовый гигант
  star: 0.3, // 0.09 <= k < 0.3      -> каменистое тело (планета/астероид)
  whiteDwarf: 4, // 0.3 <= k < 4     -> звезда
  neutronStar: 45, // 4 <= k < 45    -> белый карлик
  blackHole: 120, // 45 <= k < 120   -> нейтронная звезда; k >= 120 -> чёрная дыра
} as const;

// Радиус, ниже которого каменистое тело называется астероидом (только для имени).
export const ASTEROID_MAX_RADIUS = 14;

// Порядок = порядок в палитре (путь «от простого к экзотическому»).
export const OBJECT_TYPES: ObjectType[] = [
  { id: "asteroid", name: "Астероид", density: 0.12, minRadius: 3, maxRadius: 12, defaultRadius: 6, accent: "#9b9488", hint: "Малая масса — быстро поглощается крупными телами." },
  { id: "rocky", name: "Планета", density: 0.15, minRadius: 8, maxRadius: 55, defaultRadius: 22, accent: "#5fa8d3", hint: "Сбалансированное тело: сливается на малой скорости, дробится на большой." },
  { id: "gasGiant", name: "Газовый гигант", density: 0.04, minRadius: 45, maxRadius: 120, defaultRadius: 72, accent: "#d9b38c", hint: "Рыхлый и крупный — легко разрушается при сильном ударе." },
  { id: "star", name: "Звезда", density: 0.6, minRadius: 28, maxRadius: 95, defaultRadius: 52, accent: "#ffd56b", hint: "Массивная и яркая: доминирует гравитацией в системе." },
  { id: "whiteDwarf", name: "Белый карлик", density: 12, minRadius: 6, maxRadius: 14, defaultRadius: 9, accent: "#dfe8ff", hint: "Плотный остаток звезды — поглощает мелкие тела." },
  { id: "neutronStar", name: "Нейтронная звезда", density: 70, minRadius: 4, maxRadius: 9, defaultRadius: 6, accent: "#9fe7ff", hint: "Сверхплотная — поглощает почти всё, что коснётся." },
  { id: "blackHole", name: "Чёрная дыра", density: 200, minRadius: 12, maxRadius: 22, defaultRadius: 15, accent: "#a86bff", hint: "Горизонт событий: поглощает любое тело независимо от скорости." },
];

export const OBJECT_TYPE_MAP: Record<ObjectTypeId, ObjectType> = OBJECT_TYPES.reduce(
  (map, type) => {
    map[type.id] = type;
    return map;
  },
  {} as Record<ObjectTypeId, ObjectType>,
);

/** Масса тела данного типа при заданном радиусе: mass = density * r^2. */
export function massFor(type: ObjectType, radius: number): number {
  return type.density * radius * radius;
}

/**
 * Восстанавливает тип тела по его плотности (та же лестница, что в шейдере).
 * Каменистый band делится по радиусу на «Астероид» / «Планета» — только для имени.
 */
export function classifyByDensity(density: number, radius: number): ObjectType {
  if (density >= DENSITY_BANDS.blackHole) return OBJECT_TYPE_MAP.blackHole;
  if (density >= DENSITY_BANDS.neutronStar) return OBJECT_TYPE_MAP.neutronStar;
  if (density >= DENSITY_BANDS.whiteDwarf) return OBJECT_TYPE_MAP.whiteDwarf;
  if (density >= DENSITY_BANDS.star) return OBJECT_TYPE_MAP.star;
  if (density < DENSITY_BANDS.gasGiant) return OBJECT_TYPE_MAP.gasGiant;
  return radius < ASTEROID_MAX_RADIUS ? OBJECT_TYPE_MAP.asteroid : OBJECT_TYPE_MAP.rocky;
}
