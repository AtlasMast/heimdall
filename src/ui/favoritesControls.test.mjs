import assert from 'node:assert/strict';
import test from 'node:test';
import { FavoritesControls } from './favoritesControls.js';

function node(tag = 'div') {
  const classes = new Set();
  const attributes = new Map();
  const el = {
    tag,
    children: [],
    dataset: {},
    listeners: new Map(),
    textContent: '',
    value: '',
    get className() {
      return [...classes].join(' ');
    },
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean))
        classes.add(name);
    },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, enabled = !classes.has(name)) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      this.listeners.get(name)?.delete(callback);
    },
    fire(name, event = {}) {
      for (const callback of this.listeners.get(name) || []) callback(event);
    },
    appendChild(child) {
      this.children.push(child);
    },
    append(...children) {
      children.forEach((child) => this.appendChild(child));
    },
    replaceChildren() {
      this.children = [];
    },
    querySelectorAll(selector) {
      const name = selector.slice(1);
      return this.children.flatMap((child) => [
        ...(child.classList.contains(name) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    },
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
  };
  return el;
}

function fixture({ saveResult = true } = {}) {
  const elements = {
    saveButton: node('button'),
    nameInput: node('input'),
    list: node(),
  };
  const doc = { createElement: node };
  const calls = [];
  const controls = new FavoritesControls({
    elements,
    doc,
    suggestName: () => 'Tokyo',
    onSave: (name) => {
      calls.push(['save', name]);
      return saveResult;
    },
    onFly: (id) => calls.push(['fly', id]),
    onDelete: (id) => calls.push(['delete', id]),
  });
  return { elements, controls, calls };
}

const FAVORITES = [
  { id: 'f1', name: 'Shibuya Crossing' },
  { id: 'f2', name: 'Golden Gate' },
];

test('SAVE VIEW opens a prefilled name field and Enter saves it', () => {
  const { elements, calls } = fixture();
  elements.saveButton.fire('click');
  assert.equal(elements.nameInput.classList.contains('expanded'), true);
  assert.equal(elements.nameInput.value, 'Tokyo');
  assert.equal(elements.nameInput.focused, true);
  assert.equal(elements.saveButton.getAttribute('aria-expanded'), 'true');

  elements.nameInput.value = 'Tokyo Tower';
  let stopped = false;
  elements.nameInput.fire('keydown', {
    key: 'Enter',
    stopPropagation: () => (stopped = true),
    preventDefault() {},
  });
  assert.equal(stopped, true);
  assert.deepEqual(calls, [['save', 'Tokyo Tower']]);
  assert.equal(elements.nameInput.classList.contains('expanded'), false);
  assert.equal(elements.saveButton.getAttribute('aria-expanded'), 'false');
});

test('a second SAVE VIEW click submits; Escape cancels without saving', () => {
  const { elements, calls } = fixture();
  elements.saveButton.fire('click');
  elements.saveButton.fire('click');
  assert.deepEqual(calls, [['save', 'Tokyo']]);

  elements.saveButton.fire('click');
  elements.nameInput.fire('keydown', { key: 'Escape' });
  assert.equal(elements.nameInput.classList.contains('expanded'), false);
  assert.equal(calls.length, 1);
});

test('a rejected name keeps the field open for correction', () => {
  const { elements } = fixture({ saveResult: false });
  elements.saveButton.fire('click');
  elements.nameInput.fire('keydown', { key: 'Enter' });
  assert.equal(elements.nameInput.classList.contains('expanded'), true);
});

test('render lists favorites with fly and delete actions', () => {
  const { elements, controls, calls } = fixture();
  controls.render(FAVORITES);
  const pills = elements.list.querySelectorAll('.favorite-pill');
  assert.deepEqual(
    pills.map((pill) => pill.textContent),
    ['Shibuya Crossing', 'Golden Gate'],
  );
  pills[1].fire('click');
  const deletes = elements.list.querySelectorAll('.favorite-delete');
  assert.equal(
    deletes[0].getAttribute('aria-label'),
    'Delete favorite Shibuya Crossing',
  );
  deletes[0].fire('click');
  assert.deepEqual(calls, [
    ['fly', 'f2'],
    ['delete', 'f1'],
  ]);

  controls.highlight('f2');
  assert.deepEqual(
    pills.map((pill) => pill.classList.contains('active')),
    [false, true],
  );
});

test('an empty list shows a hint, and re-render drops old listeners', () => {
  const { elements, controls, calls } = fixture();
  controls.render(FAVORITES);
  const stale = elements.list.querySelectorAll('.favorite-pill')[0];
  controls.render([]);
  assert.equal(elements.list.children.length, 1);
  assert.equal(elements.list.children[0].textContent, 'No saved views yet');
  stale.fire('click');
  assert.deepEqual(calls, []);
});

test('missing markup and destroy are both safe', () => {
  const controls = new FavoritesControls({
    elements: {},
    onSave() {},
    onFly() {},
    onDelete() {},
    doc: { createElement: node },
  });
  controls.render(FAVORITES);
  controls.beginNaming();
  controls.highlight('f1');
  controls.destroy();

  const { elements, controls: live, calls } = fixture();
  live.destroy();
  elements.saveButton.fire('click');
  assert.deepEqual(calls, []);
});
