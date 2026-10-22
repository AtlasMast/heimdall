import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  caltransVideoUrl,
  loadCaltransSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';

const STILL = 'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv101/tv101.jpg';
const STREAM =
  'https://wzmedia.dot.ca.gov/D4/N880_at_Davis_St.stream/playlist.m3u8';

/** Set env vars for one test and restore them afterwards. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** One district feed holding a single in-service camera. */
function serveCamera(t, imageData) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        {
          cctv: {
            inService: 'true',
            location: {
              latitude: '37.8044',
              longitude: '-122.2712',
              elevation: '20',
              direction: 'North',
              locationName: 'TV101 -- I-880 : Davis St',
            },
            imageData,
          },
        },
      ],
    }),
  );
}

test('a Caltrans camera that streams plays live HLS with the still as fallback', async (t) => {
  withEnv(t, { CCTV_CALTRANS_DISTRICTS: '4', CCTV_CALTRANS_VIDEO: undefined });
  serveCamera(t, {
    streamingVideoURL: STREAM,
    static: { currentImageURL: STILL },
  });
  const [camera] = await loadCaltransSourcesFromOpenData();
  assert.equal(camera.feedType, 'hls');
  assert.equal(camera.url, STREAM);
  assert.equal(camera.snapshotUrl, STILL);
});

test('a Caltrans camera without a stream stays a still', async (t) => {
  withEnv(t, { CCTV_CALTRANS_DISTRICTS: '4', CCTV_CALTRANS_VIDEO: undefined });
  serveCamera(t, {
    streamingVideoURL: 'Not Reported',
    static: { currentImageURL: STILL },
  });
  const [camera] = await loadCaltransSourcesFromOpenData();
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.url, STILL);
  assert.equal(camera.snapshotUrl, STILL);
});

test('only the exact manifest path on the Caltrans video host is registered', (t) => {
  withEnv(t, { CCTV_CALTRANS_VIDEO: undefined });
  assert.equal(caltransVideoUrl({ streamingVideoURL: STREAM }), STREAM);
  assert.equal(caltransVideoUrl({ streamingVideoURL: ` ${STREAM} ` }), STREAM);
  for (const rejected of [
    '',
    'Not Reported',
    'http://wzmedia.dot.ca.gov/D4/N880_at_Davis_St.stream/playlist.m3u8',
    'https://evil.test/D4/N880_at_Davis_St.stream/playlist.m3u8',
    'https://user:pw@wzmedia.dot.ca.gov/D4/N880.stream/playlist.m3u8',
    `${STREAM}?redirect=https://evil.test/`,
    'https://wzmedia.dot.ca.gov/D4/../admin.stream/playlist.m3u8',
    'https://wzmedia.dot.ca.gov/D4/N880.stream/chunklist_w1.m3u8',
    'https://wzmedia.dot.ca.gov:8443/D4/N880.stream/playlist.m3u8',
  ])
    assert.equal(
      caltransVideoUrl({ streamingVideoURL: rejected }),
      '',
      rejected,
    );
  assert.equal(caltransVideoUrl(undefined), '');
});

test('CCTV_CALTRANS_VIDEO=0 keeps every Caltrans camera on stills', async (t) => {
  withEnv(t, { CCTV_CALTRANS_DISTRICTS: '4', CCTV_CALTRANS_VIDEO: '0' });
  serveCamera(t, {
    streamingVideoURL: STREAM,
    static: { currentImageURL: STILL },
  });
  const [camera] = await loadCaltransSourcesFromOpenData();
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.url, STILL);
});
