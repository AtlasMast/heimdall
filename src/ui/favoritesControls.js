import { t } from '../i18n/index.js';

/** Favorites row DOM: save-view input, one pill per favorite, delete buttons. */
export class FavoritesControls {
  constructor({
    elements,
    suggestName = () => '',
    onSave,
    onFly,
    onDelete,
    doc = document,
  }) {
    Object.assign(this, {
      elements,
      suggestName,
      onSave,
      onFly,
      onDelete,
      doc,
    });
    this.removers = [];
    this.itemRemovers = [];
    this.destroyed = false;
    this.bind(elements.saveButton, 'click', () => {
      if (this.isNaming()) this.submit();
      else this.beginNaming();
    });
    this.bind(elements.nameInput, 'keydown', (event) => {
      // The app's global shortcuts must not fire while a name is typed.
      event.stopPropagation?.();
      if (event.key === 'Enter') {
        event.preventDefault?.();
        this.submit();
      } else if (event.key === 'Escape') {
        event.preventDefault?.();
        this.endNaming();
      }
    });
  }
  bind(element, event, handler, removers = this.removers) {
    if (!element) return;
    const listener = (...args) => {
      if (!this.destroyed) return handler(...args);
    };
    element.addEventListener(event, listener);
    removers.push(() => element.removeEventListener(event, listener));
  }
  isNaming() {
    return !!this.elements.nameInput?.classList.contains('expanded');
  }
  beginNaming() {
    const input = this.elements.nameInput;
    if (this.destroyed || !input) return;
    input.value = this.suggestName() || '';
    input.classList.add('expanded');
    this.elements.saveButton?.setAttribute('aria-expanded', 'true');
    input.focus?.();
    input.select?.();
  }
  endNaming() {
    const input = this.elements.nameInput;
    if (!input) return;
    input.classList.remove('expanded');
    input.value = '';
    this.elements.saveButton?.setAttribute('aria-expanded', 'false');
  }
  submit() {
    const input = this.elements.nameInput;
    if (this.destroyed || !input) return;
    const saved = this.onSave(input.value);
    // Keep the field open on a rejected name so it can be corrected.
    if (saved !== false) this.endNaming();
  }
  render(favorites) {
    const list = this.elements.list;
    if (this.destroyed || !list) return;
    for (const remove of this.itemRemovers.splice(0)) remove();
    list.replaceChildren();
    if (!favorites.length) {
      const empty = this.doc.createElement('span');
      empty.className = 'favorites-empty';
      empty.textContent = t('No saved views yet');
      list.appendChild(empty);
      return;
    }
    for (const favorite of favorites) {
      const item = this.doc.createElement('span');
      item.className = 'favorite-item';
      item.dataset.favoriteId = favorite.id;
      const pill = this.doc.createElement('button');
      pill.type = 'button';
      pill.className = 'location-pill favorite-pill';
      pill.dataset.favoriteId = favorite.id;
      pill.textContent = favorite.name;
      pill.title = t('Fly to {name}', { name: favorite.name });
      const remove = this.doc.createElement('button');
      remove.type = 'button';
      remove.className = 'favorite-delete';
      remove.dataset.favoriteId = favorite.id;
      remove.textContent = '×';
      const removeLabel = t('Delete favorite {name}', { name: favorite.name });
      remove.title = removeLabel;
      remove.setAttribute?.('aria-label', removeLabel);
      this.bind(
        pill,
        'click',
        () => this.onFly(favorite.id),
        this.itemRemovers,
      );
      this.bind(
        remove,
        'click',
        () => this.onDelete(favorite.id),
        this.itemRemovers,
      );
      item.append(pill, remove);
      list.appendChild(item);
    }
  }
  highlight(id) {
    if (this.destroyed || !this.elements.list) return;
    for (const pill of this.elements.list.querySelectorAll('.favorite-pill'))
      pill.classList.toggle('active', pill.dataset.favoriteId === id);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const remove of [
      ...this.itemRemovers.splice(0),
      ...this.removers.splice(0),
    ])
      remove();
  }
}
