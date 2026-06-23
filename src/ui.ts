import type { BodySnapshot } from "./gpu-engine";

function formatNumber(value: number, digits = 1): string {
  const safeValue = Math.abs(value) < 0.05 ? 0 : value;
  return safeValue.toFixed(digits);
}

const STAR_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.7l1.85 3.9 4.25.5-3.15 2.95.83 4.25L8 11.65 4.22 13.3l.83-4.25L1.9 6.1l4.25-.5z" fill="currentColor" stroke="currentColor" stroke-width=".8" stroke-linejoin="round"/></svg>`;

type CardRefs = {
  card: HTMLElement;
  mass: HTMLElement;
  density: HTMLElement;
  radius: HTMLElement;
  speed: HTMLElement;
  coords: HTMLElement;
  favorite: HTMLButtonElement;
};

export class BodiesSidebar {
  private readonly container: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly count: HTMLElement;
  private readonly emptyTitle: HTMLElement;
  private readonly emptyText: HTMLElement;
  private readonly cards = new Map<number, CardRefs>();
  private readonly favorites = new Set<number>();
  private selectedId: number | null = null;
  private scrollToSelected = false;
  private readonly onFocus: (id: number) => void;
  private readonly onDelete: (id: number) => void;

  constructor(onFocus: (id: number) => void, onDelete: (id: number) => void) {
    this.container = document.querySelector<HTMLElement>("#bodies-list")!;
    this.empty = document.querySelector<HTMLElement>("#empty-bodies")!;
    this.count = document.querySelector<HTMLElement>("#planet-count")!;
    this.emptyTitle = this.empty.querySelector<HTMLElement>("strong")!;
    this.emptyText = this.empty.querySelector<HTMLElement>("p")!;
    this.onFocus = onFocus;
    this.onDelete = onDelete;
  }

  update(bodies: BodySnapshot[]): void {
    // В списке — крупные тела + выбранное (даже если это осколок), чтобы любое
    // выбранное тело было видно и его карточку можно было пролистать.
    const visible = bodies.filter((body) => !body.isFragment || body.id === this.selectedId);
    const liveIds = new Set(visible.map((body) => body.id));

    // Удаляем карточки исчезнувших тел (слияние/удаление).
    for (const [id, refs] of this.cards) {
      if (!liveIds.has(id)) {
        refs.card.remove();
        this.cards.delete(id);
        this.favorites.delete(id);
        if (this.selectedId === id) this.selectedId = null;
      }
    }

    // Создаём недостающие карточки и обновляем только текстовые значения у
    // существующих — без полной перерисовки DOM (список не дёргается).
    for (const body of visible) {
      let refs = this.cards.get(body.id);
      if (!refs) {
        refs = this.createCard(body);
        this.cards.set(body.id, refs);
        this.container.appendChild(refs.card);
      }
      refs.card.classList.toggle("is-fragment", body.isFragment);
      this.updateValues(refs, body);
    }

    this.reorder();
    this.applySelection();
    this.count.textContent = String(bodies.length);
    const fragmentCount = bodies.reduce((total, body) => total + (body.isFragment ? 1 : 0), 0);
    const onlyHiddenFragments = visible.length === 0 && fragmentCount > 0;
    this.emptyTitle.textContent = onlyHiddenFragments ? `Осколков: ${fragmentCount}` : "Объектов пока нет";
    this.emptyText.textContent = onlyHiddenFragments
      ? "Выберите осколок на холсте, чтобы открыть его параметры."
      : "Создайте планету на холсте — она появится здесь.";
    this.empty.hidden = visible.length > 0;
  }

  setSelected(id: number | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.scrollToSelected = id !== null;
    this.applySelection();
  }

  // Подсветка активной карточки + автоскролл к ней. Скролл откладывается, если
  // карточки ещё нет (выбранный осколок появится после ближайшего update).
  private applySelection(): void {
    for (const [cardId, refs] of this.cards) {
      refs.card.classList.toggle("is-selected", cardId === this.selectedId);
    }
    if (this.scrollToSelected && this.selectedId !== null) {
      const refs = this.cards.get(this.selectedId);
      if (refs) {
        refs.card.scrollIntoView({ block: "nearest", behavior: "smooth" });
        this.scrollToSelected = false;
      }
    }
  }

  private rank(id: number): number {
    return this.favorites.has(id) ? 0 : 1;
  }

  // Избранные закреплены вверху, остальные — по id. Переставляем уже
  // существующие DOM-узлы, не создавая их заново.
  private reorder(): void {
    const ordered = [...this.cards.entries()].sort(([idA], [idB]) => {
      const rankA = this.rank(idA);
      const rankB = this.rank(idB);
      return rankA !== rankB ? rankA - rankB : idA - idB;
    });
    ordered.forEach(([, refs], index) => {
      if (this.container.children[index] !== refs.card) {
        this.container.insertBefore(refs.card, this.container.children[index] ?? null);
      }
    });
  }

  private updateValues(refs: CardRefs, body: BodySnapshot): void {
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    refs.mass.textContent = formatNumber(body.mass, 2);
    refs.density.textContent = formatNumber(body.density, 2);
    refs.radius.textContent = formatNumber(body.radius, 1);
    refs.speed.innerHTML = `${formatNumber(speed)} <small>ед/с</small>`;
    refs.coords.textContent = `${formatNumber(body.position.x)}, ${formatNumber(body.position.y)}`;
  }

  private toggleFavorite(id: number): void {
    if (this.favorites.has(id)) this.favorites.delete(id);
    else this.favorites.add(id);
    const refs = this.cards.get(id);
    if (refs) {
      const active = this.favorites.has(id);
      refs.favorite.classList.toggle("is-active", active);
      refs.favorite.setAttribute("aria-pressed", String(active));
      refs.card.classList.toggle("is-favorite", active);
    }
    this.reorder();
  }

  private createCard(body: BodySnapshot): CardRefs {
    const card = document.createElement("article");
    card.className = "body-card";
    card.innerHTML = `
      <div class="body-card-heading">
        <button class="focus-body" type="button" aria-label="Сфокусировать камеру на ${body.name}">
          <span class="body-color" style="--body-hue: ${body.hue}"></span>
          <strong>${body.name}</strong>
        </button>
        <button class="favorite-toggle" type="button" aria-pressed="false" aria-label="В избранное" title="В избранное">${STAR_ICON}</button>
        <button class="delete-body" type="button" aria-label="Удалить ${body.name}" title="Удалить"><span aria-hidden="true">×</span></button>
      </div>
      <dl class="body-metrics">
        <div><dt>Масса</dt><dd class="metric-mass"></dd></div>
        <div><dt>Плотность</dt><dd class="metric-density"></dd></div>
        <div><dt>Радиус</dt><dd class="metric-radius"></dd></div>
        <div><dt>Скорость</dt><dd class="metric-speed"></dd></div>
        <div class="coordinates"><dt>Координаты</dt><dd class="metric-coords"></dd></div>
      </dl>`;

    const refs: CardRefs = {
      card,
      mass: card.querySelector<HTMLElement>(".metric-mass")!,
      density: card.querySelector<HTMLElement>(".metric-density")!,
      radius: card.querySelector<HTMLElement>(".metric-radius")!,
      speed: card.querySelector<HTMLElement>(".metric-speed")!,
      coords: card.querySelector<HTMLElement>(".metric-coords")!,
      favorite: card.querySelector<HTMLButtonElement>(".favorite-toggle")!,
    };

    card.querySelector<HTMLButtonElement>(".focus-body")!.addEventListener("click", () => this.onFocus(body.id));
    refs.favorite.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleFavorite(body.id);
    });
    card.querySelector<HTMLButtonElement>(".delete-body")!.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onDelete(body.id);
    });

    if (this.selectedId === body.id) card.classList.add("is-selected");
    return refs;
  }
}
