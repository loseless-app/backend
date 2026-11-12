import test from "node:test";
import assert from "node:assert/strict";

import {
  STREAM_PLAYBACK_STATES,
  clampStreamPosition,
  computeStreamPosition,
  sanitizeStreamClockPayload,
  serializeStreamPlayback,
} from "../src/utils/streamClock.js";

test("streamClock: positions clamp to the media duration", () => {
  assert.equal(clampStreamPosition(-2), 0);
  assert.equal(clampStreamPosition(15), 15);
  assert.equal(clampStreamPosition(120, 90), 90);
  assert.equal(clampStreamPosition(Number.NaN), 0);
});

test("streamClock: playing clocks advance from their anchor", () => {
  const playback = {
    isPlaying: true,
    anchorTime: 10,
    lastStartedAt: 1_000,
    state: STREAM_PLAYBACK_STATES.PLAYING,
  };

  assert.equal(computeStreamPosition(playback, 3_000, 60), 12);
  assert.equal(computeStreamPosition(playback, 90_000, 60), 60);
});

test("streamClock: paused, buffering and ended clocks stay frozen", () => {
  const playback = { isPlaying: false, anchorTime: 22, lastStartedAt: 1_000 };

  assert.equal(
    computeStreamPosition({ ...playback, state: STREAM_PLAYBACK_STATES.PAUSED }, 9_000, 100),
    22
  );
  assert.equal(
    computeStreamPosition({ ...playback, state: STREAM_PLAYBACK_STATES.ENDED }, 9_000, 100),
    22
  );

  // Buffering keeps isPlaying true but must not extrapolate.
  assert.equal(
    computeStreamPosition(
      { ...playback, isPlaying: true, state: STREAM_PLAYBACK_STATES.BUFFERING },
      9_000,
      100
    ),
    22
  );
});

test("streamClock: sanitize validates state and falls back to the known duration", () => {
  const clock = sanitizeStreamClockPayload(
    { isPlaying: true, anchorTime: 44, state: "nonsense" },
    { duration: 180 }
  );

  assert.equal(clock.state, STREAM_PLAYBACK_STATES.PLAYING);
  assert.equal(clock.anchorTime, 44);
  assert.equal(clock.duration, 180);
  assert.equal(sanitizeStreamClockPayload(null), null);
});

test("streamClock: serialization exposes a ready-to-use position", () => {
  const now = 5_000;
  const room = {
    streamMetadata: { duration: 200 },
    streamPlayback: {
      isPlaying: true,
      anchorTime: 30,
      lastStartedAt: 3_000,
      state: STREAM_PLAYBACK_STATES.PLAYING,
      seq: 7,
    },
  };

  const serialized = serializeStreamPlayback(room, now);

  assert.equal(serialized.position, 32);
  assert.equal(serialized.duration, 200);
  assert.equal(serialized.seq, 7);
  assert.equal(serialized.state, STREAM_PLAYBACK_STATES.PLAYING);
  assert.equal(serialized.updatedAt, now);
  assert.equal(serializeStreamPlayback({ streamPlayback: null }, now), null);
});
