import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createState } from './state.js';
import { createStyle } from './style.js';
import { createModel } from './model.js';
import { createAnimation } from './animation.js';
import { createRetention } from './retention.js';
import { createTrafficLayer } from './index.js';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  serializeStoredLayerState,
  parseStoredLayerState,
} from '../../data/layerState.js';

function setup(t, { liveMode = true } = {}) {
  const frames = [];
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const beforeRAF = globalThis.requestAnimationFrame;
  const beforeCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => (frames.push(fn), frames.length);
  globalThis.cancelAnimationFrame = () => {
    frames.length = 0;
  };
  t.after(() => {
    globalThis.requestAnimationFrame = beforeRAF;
    globalThis.cancelAnimationFrame = beforeCancel;
  });
  const state = createState({ services: {} });
  state._enabled = true;
  state._liveMode = liveMode;
  state._pointCollection = new C.PointPrimitiveCollection();
  state._viewer = { scene: {} };
  const heatRebuilds = [];
  const parts = {
    rendering: {
      removeHeatLines() {},
      rebuildHeatLines(roads) {
        heatRebuilds.push(roads);
      },
      visibleRoadsForAltitude: (roads) => roads,
    },
  };
  const ctx = { state, services: {}, parts, source: {} };
  parts.style = createStyle(ctx);
  parts.model = createModel(ctx);
  parts.animation = createAnimation(ctx);
  parts.retention = createRetention(ctx);
  const roads = () =>
    parts.model
      .parseRoads({
        roads: [
          {
            type: 'primary',
            oneway: 1,
            coordinates: [
              [0, 0],
              [0.003, 0],
              [0.004, 0.001],
            ],
          },
        ],
      })
      .map((road) => {
        road.waypoints = road.coords.map(([lon, lat]) =>
          C.Cartesian3.fromDegrees(lon, lat, 100),
        );
        road.segmentDist = road.waypoints
          .slice(1)
          .map((p, i) => C.Cartesian3.distance(road.waypoints[i], p));
        road.flow = liveMode ? { level: 0.2, closure: false } : undefined;
        return road;
      });
  const settle = () => {
    for (let i = 0; i < 100 && frames.length; i++) {
      now += 16;
      frames.shift()?.();
      parts.animation.animate();
    }
  };
  t.after(() => {
    parts.animation.clearDots();
    state._pointCollection.destroy();
  });
  return { state, parts, roads, settle, heatRebuilds };
}

test('real data only spawns no simulated dots in live mode', (t) => {
  const h = setup(t);
  h.state._realOnly = true;
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  assert.equal(h.state._dots.length, 0);
  assert.equal(h.state._roads.length, 1);
});

test('toggling real data only retires existing dots and brings them back', (t) => {
  const h = setup(t);
  const roads = h.roads();
  h.parts.retention.reconcile(roads, 450, true);
  h.settle();
  assert.ok(h.state._dots.length > 0);
  h.state._realOnly = true;
  h.parts.retention.reconcile(h.state._roads, 450, true);
  h.settle();
  assert.equal(h.state._dots.length, 0);
  h.state._realOnly = false;
  h.parts.retention.reconcile(h.state._roads, 450, true);
  h.settle();
  assert.ok(h.state._dots.length > 0);
});

test('late flow still repaints road segments when real data only has no dots', (t) => {
  const h = setup(t);
  h.state._realOnly = true;
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  const [road] = h.state._roads;
  road.source.flow = { level: 0.9, closure: false };
  h.parts.model.recolorDotsInPlace('late flow');
  assert.equal(road.flow.level, 0.9);
  assert.equal(h.heatRebuilds.length, 1);
  assert.deepEqual(h.heatRebuilds[0], h.state._roads);
});

test('without a TomTom key the setting is ignored and the simulation runs', (t) => {
  const h = setup(t, { liveMode: false });
  h.state._realOnly = true;
  assert.equal(h.parts.style.realOnlyOn(), false);
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  assert.ok(h.state._dots.length > 0);
});

function layer() {
  return createTrafficLayer({
    services: { credits: {}, render: {} },
    source: {
      requestRoads() {},
      getStatus() {},
      fetchFlowForBounds() {},
      getFlowSessionStats: () => ({}),
      resetFlowTileCache() {},
    },
  });
}

test('real-only chip and caption say what is simulated and what is live', () => {
  const keyless = layer();
  let controls = keyless.getRowControls();
  let chip = controls.chips.find((c) => c.id === 'real-only');
  assert.equal(chip.disabled, true);
  assert.equal(chip.active, false);
  assert.match(controls.info, /Vehicles are simulated/);
  assert.match(controls.info, /TomTom key/);

  const restored = layer();
  assert.equal(restored.getParams().realOnly, false);
  restored.setParams({ realOnly: true }, { origin: 'user' });
  assert.equal(restored.getParams().realOnly, true);
  // Still keyless, so the view stays the simulation.
  assert.equal(restored.getStats().realOnly, false);
  chip = restored.getRowControls().chips.find((c) => c.id === 'real-only');
  assert.deepEqual(chip.params, { realOnly: false });
});

test('feed presentation names the real-only view honestly', (t) => {
  const h = setup(t);
  const present = (extra) =>
    h.parts.model.trafficFeedPresentation({
      liveMode: true,
      realOnly: true,
      ...extra,
    });
  assert.equal(
    present({ flowRoads: 12 }).loadingLabel,
    'LIVE · Real data only · 12 flow roads',
  );
  assert.equal(
    present({ flowRoads: 1 }).loadingLabel,
    'LIVE · Real data only · 1 flow road',
  );
  assert.equal(
    present({ flowRoads: 0 }).loadingLabel,
    'LIVE · Real data only · No flow roads in view',
  );
  const degraded = present({ flowError: 'TomTom daily budget reached' });
  assert.match(degraded.error, /^NO LIVE FLOW — /);
  assert.doesNotMatch(degraded.error, /SIMULATED/);
});

test('real-only setting persists in share links and local storage', () => {
  const state = createDefaultLayerState();
  assert.equal(state.options.traffic.realOnly, false);
  state.enabledLayerIds = ['traffic'];
  state.options.traffic.realOnly = true;
  const params = new URLSearchParams('v=2');
  encodeLayerStateParams(params, state);
  assert.equal(decodeLayerStateParams(params).options.traffic.realOnly, true);
  assert.equal(
    parseStoredLayerState(serializeStoredLayerState(state)).options.traffic
      .realOnly,
    true,
  );
});
