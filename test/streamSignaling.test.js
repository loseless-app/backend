import test from "node:test";
import assert from "node:assert/strict";
import { registerSyncHandlers } from "../src/sockets/syncHandler.js";
import { getOrCreateRoom, addMemberToRoom, getRoom, serializeRoom } from "../src/stores/roomStore.js";

// Helper mock socket & io
function createMockEnvironment() {
  const emittedEvents = new Map(); // socketId or roomId -> array of { event, data }

  const io = {
    to: (targetId) => ({
      emit: (event, data) => {
        if (!emittedEvents.has(targetId)) emittedEvents.set(targetId, []);
        emittedEvents.get(targetId).push({ event, data });
      },
    }),
  };

  const createSocket = (id, roomId = null, username = "User", isHost = false) => {
    const handlers = new Map();
    const socket = {
      id,
      data: { roomId, username, isHost },
      on: (event, handler) => {
        handlers.set(event, handler);
      },
      emit: (event, data) => {
        if (!emittedEvents.has(id)) emittedEvents.set(id, []);
        emittedEvents.get(id).push({ event, data });
      },
      leave: () => {},
      join: () => {},
      to: (target) => io.to(target),
      _trigger: (event, payload, cb) => {
        if (handlers.has(event)) {
          return handlers.get(event)(payload, cb);
        }
      },
    };
    registerSyncHandlers(io, socket);
    return socket;
  };

  return { io, createSocket, emittedEvents };
}

test("backend: change_source sets mediaType: 'stream' and populates streamMetadata", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-source-test";
  getOrCreateRoom(roomId);

  const hostSocket = createSocket("sock-stream-host", roomId, "HostAlice", true);
  addMemberToRoom(roomId, hostSocket.id, "HostAlice", true);

  hostSocket._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: {
      title: "Movie Live Stream",
      source: "file",
      hasAudio: true,
      qualityMode: "auto",
    },
  });

  const room = getRoom(roomId);
  assert.equal(room.mediaType, "stream");
  assert.equal(room.mediaOwnerSocketId, "sock-stream-host");
  assert.equal(room.mediaOwnerUsername, "HostAlice");
  assert.ok(room.streamMetadata);
  assert.equal(room.streamMetadata.title, "Movie Live Stream");
  assert.equal(room.streamMetadata.hasAudio, true);
  assert.equal(room.isPlaying, true);
  assert.equal(room.streamPlayback.isPlaying, true);
  assert.equal(room.streamPlayback.anchorTime, 0);
  assert.equal(room.streamPlayback.state, "playing");

  // Check serialization includes streamMetadata
  const serialized = serializeRoom(room);
  assert.equal(serialized.mediaType, "stream");
  assert.equal(serialized.streamMetadata.title, "Movie Live Stream");
  assert.ok(serialized.streamPlayback, "Serialized room must include the shared clock");
  assert.equal(serialized.streamPlayback.seq, 0);
  assert.equal(typeof serialized.streamPlayback.position, "number");
});

test("backend: stream:control relays play/pause to the host and rejects guest seek", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-control-test";
  getOrCreateRoom(roomId);

  const host = createSocket("sock-control-host", roomId, "Host", true);
  const viewer = createSocket("sock-control-viewer", roomId, "Viewer", false);
  addMemberToRoom(roomId, host.id, "Host", true);
  addMemberToRoom(roomId, viewer.id, "Viewer", false);

  host._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: { title: "Live Movie", source: "file", duration: 120 },
  });

  viewer._trigger("stream:control", { action: "pause", requestId: "req-1" });

  const hostEvents = emittedEvents.get(host.id) || [];
  const controlEvent = hostEvents.find((e) => e.event === "stream:control");
  assert.ok(controlEvent, "Host should receive the viewer command");
  assert.equal(controlEvent.data.action, "pause");
  assert.equal(controlEvent.data.from, viewer.id);
  assert.equal(controlEvent.data.requestId, "req-1");

  // Guests cannot seek — the host must stay the only seek authority.
  viewer._trigger("stream:control", { action: "seek", position: 60 });
  const seekEvents = (emittedEvents.get(host.id) || []).filter(
    (e) => e.event === "stream:control" && e.data.action === "seek"
  );
  assert.equal(seekEvents.length, 0, "Guest seek requests must be dropped");
});

test("backend: stream:clock accepts only the host and broadcasts a compact clock", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-clock-test";
  getOrCreateRoom(roomId);

  const host = createSocket("sock-clock-host", roomId, "Host", true);
  const viewer = createSocket("sock-clock-viewer", roomId, "Viewer", false);
  addMemberToRoom(roomId, host.id, "Host", true);
  addMemberToRoom(roomId, viewer.id, "Viewer", false);

  host._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: { title: "Live Movie", source: "file" },
  });

  // A viewer must not be able to move the shared timeline.
  viewer._trigger("stream:clock", {
    isPlaying: true,
    anchorTime: 90,
    state: "playing",
    duration: 120,
  });
  assert.equal(getRoom(roomId).streamPlayback.anchorTime, 0);

  // Host pause at 42s, with duration learned from the video element.
  host._trigger("stream:clock", {
    isPlaying: false,
    anchorTime: 42,
    state: "paused",
    duration: 120,
  });

  const room = getRoom(roomId);
  assert.equal(room.streamMetadata.duration, 120);
  assert.equal(room.streamPlayback.isPlaying, false);
  assert.equal(room.streamPlayback.anchorTime, 42);
  assert.equal(room.streamPlayback.state, "paused");
  assert.equal(room.streamPlayback.seq, 1);

  const roomEvents = emittedEvents.get(roomId) || [];
  const clockEvents = roomEvents.filter((e) => e.event === "stream:clock");
  assert.equal(clockEvents.length, 1, "Only the host's clock may be broadcast");
  assert.equal(clockEvents[0].data.position, 42);
  assert.equal(clockEvents[0].data.state, "paused");
  assert.equal(clockEvents[0].data.duration, 120);

  // Late joiners get the same ready-to-use position from room state.
  const serialized = serializeRoom(room);
  assert.equal(serialized.streamPlayback.position, 42);
  assert.equal(serialized.streamPlayback.seq, 1);
});

test("backend: stream:clock keeps sequence numbers monotonic", () => {
  const { createSocket } = createMockEnvironment();
  const roomId = "room-stream-clock-seq-test";
  getOrCreateRoom(roomId);

  const host = createSocket("sock-seq-host", roomId, "Host", true);
  addMemberToRoom(roomId, host.id, "Host", true);

  host._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: { title: "Live Movie", source: "file" },
  });

  host._trigger("stream:clock", { isPlaying: true, anchorTime: 10, state: "playing" });
  host._trigger("stream:clock", { isPlaying: true, anchorTime: 20, state: "playing" });

  assert.equal(getRoom(roomId).streamPlayback.seq, 2);
  assert.equal(getRoom(roomId).streamPlayback.anchorTime, 20);
});

test("backend: changing the stream source keeps the clock sequence monotonic", () => {
  const { createSocket } = createMockEnvironment();
  const roomId = "room-stream-source-change-test";
  getOrCreateRoom(roomId);

  const host = createSocket("sock-source-host", roomId, "Host", true);
  addMemberToRoom(roomId, host.id, "Host", true);

  host._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: { title: "First Movie", source: "file" },
  });
  assert.equal(getRoom(roomId).streamPlayback.seq, 0);

  host._trigger("stream:clock", { isPlaying: false, anchorTime: 30, state: "paused" });
  assert.equal(getRoom(roomId).streamPlayback.seq, 1);

  // A new source resets the timeline but must not rewind the sequence, or
  // clients would ignore the new clock as stale.
  host._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: { title: "Second Movie", source: "file" },
  });
  assert.equal(getRoom(roomId).streamPlayback.seq, 2);
  assert.equal(getRoom(roomId).streamPlayback.anchorTime, 0);
  assert.equal(getRoom(roomId).streamMetadata.title, "Second Movie");
});

test("backend: stream:signal validates room membership and relays SDP and ICE candidates", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-signal-test";
  getOrCreateRoom(roomId);

  const sender = createSocket("sock-broadcaster", roomId, "Broadcaster", true);
  const viewer = createSocket("sock-viewer", roomId, "Viewer", false);
  addMemberToRoom(roomId, sender.id, "Broadcaster", true);
  addMemberToRoom(roomId, viewer.id, "Viewer", false);

  // Valid SDP offer
  sender._trigger("stream:signal", {
    to: viewer.id,
    signal: {
      sdp: { type: "offer", sdp: "v=0..." },
    },
  });

  const viewerEvents = emittedEvents.get(viewer.id) || [];
  const sdpEvent = viewerEvents.find((e) => e.event === "stream:signal");
  assert.ok(sdpEvent, "Viewer should receive stream:signal");
  assert.equal(sdpEvent.data.from, sender.id);
  assert.equal(sdpEvent.data.signal.sdp.type, "offer");

  // Valid ICE candidate
  viewer._trigger("stream:signal", {
    to: sender.id,
    signal: {
      candidate: { candidate: "candidate:1...", sdpMid: "0" },
    },
  });

  const senderEvents = emittedEvents.get(sender.id) || [];
  const candEvent = senderEvents.find((e) => e.event === "stream:signal");
  assert.ok(candEvent, "Sender should receive ICE candidate");
  assert.equal(candEvent.data.from, viewer.id);
});

test("backend: stream:signal rejects non-member targets and malformed payloads", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-reject-test";
  getOrCreateRoom(roomId);

  const sender = createSocket("sock-user-1", roomId, "User1", true);
  addMemberToRoom(roomId, sender.id, "User1", true);

  // Target not in room
  sender._trigger("stream:signal", {
    to: "sock-outsider",
    signal: { sdp: { type: "offer", sdp: "v=0..." } },
  });
  assert.equal(emittedEvents.has("sock-outsider"), false);

  // Self signaling rejected
  sender._trigger("stream:signal", {
    to: sender.id,
    signal: { sdp: { type: "offer", sdp: "v=0..." } },
  });
  assert.equal(emittedEvents.has(sender.id), false);

  // Malformed signal without sdp or candidate
  sender._trigger("stream:signal", {
    to: "sock-user-2",
    signal: { foo: "bar" },
  });
  assert.equal(emittedEvents.has("sock-user-2"), false);
});

test("backend: stream:stop resets room state and notifies room peers", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-stop-test";
  getOrCreateRoom(roomId);

  const host = createSocket("sock-host-stop", roomId, "HostBob", true);
  addMemberToRoom(roomId, host.id, "HostBob", true);

  // Start stream
  host._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: { title: "Live Movie", source: "file" },
  });

  let room = getRoom(roomId);
  assert.equal(room.mediaType, "stream");

  // Host stops stream
  host._trigger("stream:stop", {});

  room = getRoom(roomId);
  assert.equal(room.mediaType, "url");
  assert.equal(room.streamMetadata, null);
  assert.equal(room.streamPlayback, null);

  const roomEvents = emittedEvents.get(roomId) || [];
  const endedEvent = roomEvents.find((e) => e.event === "stream:ended");
  assert.ok(endedEvent, "Room should receive stream:ended");
  assert.equal(endedEvent.data.by, host.id);

  // Clients render from room:state, so it must carry the reset payload too.
  const stateEvents = roomEvents.filter((e) => e.event === "room:state");
  assert.ok(stateEvents.length > 0, "Room should receive an updated room:state");
  const latestState = stateEvents[stateEvents.length - 1].data;
  assert.equal(latestState.mediaType, "url");
  assert.equal(latestState.streamMetadata, null);
  assert.equal(latestState.mediaOwnerSocketId, null);
});

test("backend: stream:signal relays a viewer's request for a fresh offer", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-request-test";
  getOrCreateRoom(roomId);

  const host = createSocket("sock-request-host", roomId, "Host", true);
  const viewer = createSocket("sock-request-viewer", roomId, "Viewer", false);
  addMemberToRoom(roomId, host.id, "Host", true);
  addMemberToRoom(roomId, viewer.id, "Viewer", false);

  viewer._trigger("stream:signal", {
    to: host.id,
    signal: { request: true },
  });

  const hostEvents = emittedEvents.get(host.id) || [];
  const requestEvent = hostEvents.find((e) => e.event === "stream:signal");
  assert.ok(requestEvent, "Host should receive the recovery request");
  assert.equal(requestEvent.data.from, viewer.id);
  assert.equal(requestEvent.data.signal.request, true);
});

test("backend: host leaving the room ends the live stream", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-stream-host-leave-test";
  getOrCreateRoom(roomId);

  const host = createSocket("sock-leave-host", roomId, "Host", true);
  const viewer = createSocket("sock-leave-viewer", roomId, "Viewer", false);
  addMemberToRoom(roomId, host.id, "Host", true);
  addMemberToRoom(roomId, viewer.id, "Viewer", false);

  host._trigger("media:action", {
    action: "change_source",
    mediaType: "stream",
    mediaMetadata: { title: "Live Movie", source: "file" },
  });
  assert.equal(getRoom(roomId).mediaType, "stream");

  host._trigger("room:leave", {});

  const room = getRoom(roomId);
  assert.ok(room, "Room should survive because the viewer is still present");
  assert.equal(room.mediaType, "url");
  assert.equal(room.streamMetadata, null);
  assert.equal(room.streamPlayback, null);
  assert.equal(room.mediaOwnerSocketId, null);

  const roomEvents = emittedEvents.get(roomId) || [];
  const endedEvent = roomEvents.find((e) => e.event === "stream:ended");
  assert.ok(endedEvent, "Viewers should be told the host's stream ended");
  assert.equal(endedEvent.data.reason, "Host left the room");

  const stateEvents = roomEvents.filter((e) => e.event === "room:state");
  assert.equal(stateEvents[stateEvents.length - 1].data.mediaType, "url");
});
