/**
 * Stream playback clock helpers (Mode 3a).
 *
 * The host is the only writer of the shared timeline. Instead of broadcasting
 * playback position every second, we store an anchor (position at the last
 * action) and the time it happened. Every client derives the current position
 * locally from those two numbers.
 */

export const STREAM_PLAYBACK_STATES = Object.freeze({
  PLAYING: "playing",
  PAUSED: "paused",
  BUFFERING: "buffering",
  ENDED: "ended",
});

const VALID_STATES = new Set(Object.values(STREAM_PLAYBACK_STATES));

/**
 * Clamps a playback position to a valid range.
 *
 * @param {number} value
 * @param {number|null} duration
 * @returns {number}
 */
export function clampStreamPosition(value, duration = null) {
  const position = Number(value);
  if (!Number.isFinite(position)) return 0;

  const safePosition = Math.max(0, position);
  const safeDuration = Number(duration);

  if (Number.isFinite(safeDuration) && safeDuration > 0) {
    return Math.min(safePosition, safeDuration);
  }

  return safePosition;
}

/**
 * Returns the current position for a stored playback clock.
 *
 * @param {{isPlaying?: boolean, anchorTime?: number, lastStartedAt?: number, state?: string}|null} playback
 * @param {number} now
 * @param {number|null} duration
 * @returns {number}
 */
export function computeStreamPosition(playback, now = Date.now(), duration = null) {
  if (!playback) return 0;

  const anchor = clampStreamPosition(playback.anchorTime, duration);
  const isRunning =
    playback.isPlaying === true &&
    (!playback.state || playback.state === STREAM_PLAYBACK_STATES.PLAYING);

  if (!isRunning) return anchor;

  const startedAt = Number(playback.lastStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return anchor;

  const elapsedSeconds = Math.max(0, now - startedAt) / 1000;
  return clampStreamPosition(anchor + elapsedSeconds, duration);
}

/**
 * Builds the compact clock payload sent to clients and stored in room state.
 * Includes a ready-to-use `position` so clients never need to compare clocks.
 *
 * @param {object|null} room
 * @param {number} now
 * @returns {object|null}
 */
export function serializeStreamPlayback(room, now = Date.now()) {
  const playback = room?.streamPlayback;
  if (!playback) return null;

  const duration = Number(room?.streamMetadata?.duration);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : null;

  return {
    isPlaying: Boolean(playback.isPlaying),
    position: computeStreamPosition(playback, now, safeDuration),
    state: VALID_STATES.has(playback.state)
      ? playback.state
      : playback.isPlaying
        ? STREAM_PLAYBACK_STATES.PLAYING
        : STREAM_PLAYBACK_STATES.PAUSED,
    seq: Number(playback.seq) || 0,
    updatedAt: now,
    duration: safeDuration,
  };
}

/**
 * Validates and normalizes a clock update coming from the stream host.
 *
 * @param {object} payload
 * @param {{duration?: number|null}} options
 * @returns {{isPlaying: boolean, anchorTime: number, state: string, duration: number|null}|null}
 */
export function sanitizeStreamClockPayload(payload, { duration = null } = {}) {
  if (!payload || typeof payload !== "object") return null;

  const state = VALID_STATES.has(payload.state)
    ? payload.state
    : payload.isPlaying
      ? STREAM_PLAYBACK_STATES.PLAYING
      : STREAM_PLAYBACK_STATES.PAUSED;

  const payloadDuration = Number(payload.duration);
  const resolvedDuration =
    Number.isFinite(payloadDuration) && payloadDuration > 0
      ? payloadDuration
      : Number.isFinite(Number(duration)) && Number(duration) > 0
        ? Number(duration)
        : null;

  return {
    isPlaying: Boolean(payload.isPlaying),
    anchorTime: clampStreamPosition(payload.anchorTime, resolvedDuration),
    state,
    duration: resolvedDuration,
  };
}
