import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { createNavigation } from './navigation.js';
import { createControls } from './controls.js';
import { cctvLiveCameras } from '../../ui/cctvPresentation.js';

const record = (id, feedType) => ({ camera: { id, feedType } });

/** The production model, navigation and camera methods over `records`. */
function layer(records) {
  const state = { _records: records, _liveOnly: false, _activeCameraId: null };
  const parts = {};
  const context = { state, services: { focus: {} }, parts, source: {} };
  parts.model = createModel(context);
  parts.navigation = createNavigation(context);
  parts.selection = {
    getActiveRecord: () =>
      records.find((entry) => entry.camera.id === state._activeCameraId) ||
      null,
    setActiveCamera: (id) => {
      state._activeCameraId = id;
    },
  };
  const { methods } = createControls({
    ...context,
    services: {
      render: {
        holdContinuousRender() {},
        releaseContinuousRender() {},
      },
      activation: {},
    },
  });
  return { state, parts, methods };
}

const RECORDS = [
  record('still-a', 'image'),
  record('live-a', 'hls'),
  record('clip', 'mp4'),
  record('live-b', 'HLS'),
  record('still-b', 'image'),
];

test('only an HLS stream counts as live; a looping clip does not', () => {
  const { parts } = layer(RECORDS);
  assert.deepEqual(
    RECORDS.filter(parts.model.isLiveRecord).map((r) => r.camera.id),
    ['live-a', 'live-b'],
  );
});

test('LIVE ONLY narrows the records the camera controls choose from', () => {
  const { state, parts } = layer(RECORDS);
  assert.equal(parts.model.eligibleRecords().length, RECORDS.length);
  state._liveOnly = true;
  assert.deepEqual(
    parts.model.eligibleRecords().map((r) => r.camera.id),
    ['live-a', 'live-b'],
  );
});

test('NEXT and PREV cycle through live cameras only while LIVE ONLY is on', () => {
  const { state, methods } = layer(RECORDS);
  state._liveOnly = true;
  // From a still-only camera the user was already watching.
  state._activeCameraId = 'still-b';
  assert.equal(methods.cycleCamera(1), 'live-a');
  assert.equal(methods.cycleCamera(1), 'live-b');
  assert.equal(methods.cycleCamera(1), 'live-a');
  assert.equal(methods.cycleCamera(-1), 'live-b');

  state._liveOnly = false;
  assert.equal(methods.cycleCamera(1), 'still-b');
});

test('with LIVE ONLY on and no live cameras, NEXT selects nothing', () => {
  const { state, methods } = layer([record('a', 'image'), record('b', 'jpg')]);
  state._liveOnly = true;
  assert.equal(methods.cycleCamera(1), null);
  assert.equal(state._activeCameraId, null);
});

test('LIVE ONLY is a round-tripped layer parameter', () => {
  const { state, methods, parts } = layer(RECORDS);
  const culled = [];
  parts.rendering = {
    refreshHorizonCulling: () => culled.push('cull'),
    refreshCoverageStyles() {},
  };
  parts.cards = { refreshAmbientCards: () => culled.push('cards') };
  parts.presentation = { notifyListeners() {} };
  methods.setParams({ liveOnly: true });
  assert.equal(state._liveOnly, true);
  assert.equal(methods.getParams().liveOnly, true);
  assert.deepEqual(culled, ['cull', 'cards'], 'markers and cards refresh');
  methods.setParams({ liveOnly: true });
  assert.equal(culled.length, 2, 'an unchanged value refreshes nothing');
});

test('the panel lists live cameras plus the camera being watched', () => {
  const cameras = [
    { id: 'still-a', feedType: 'image' },
    { id: 'live-a', feedType: 'hls' },
    { id: 'still-b', feedType: 'image' },
  ];
  assert.deepEqual(
    cctvLiveCameras(cameras, '').map((c) => c.id),
    ['live-a'],
  );
  assert.deepEqual(
    cctvLiveCameras(cameras, 'still-b').map((c) => c.id),
    ['live-a', 'still-b'],
  );
  assert.deepEqual(cctvLiveCameras(undefined), []);
});
