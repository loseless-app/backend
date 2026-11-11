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

  // Check serialization includes streamMetadata
  const serialized = serializeRoom(room);
  assert.equal(serialized.mediaType, "stream");
  assert.equal(serialized.streamMetadata.title, "Movie Live Stream");
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

  const roomEvents = emittedEvents.get(roomId) || [];
  const endedEvent = roomEvents.find((e) => e.event === "stream:ended");
  assert.ok(endedEvent, "Room should receive stream:ended");
  assert.equal(endedEvent.data.by, host.id);
});
