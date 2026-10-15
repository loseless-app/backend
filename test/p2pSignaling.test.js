import test from "node:test";
import assert from "node:assert/strict";
import { registerSyncHandlers } from "../src/sockets/syncHandler.js";
import { getOrCreateRoom, addMemberToRoom, removeMemberFromRoom } from "../src/stores/roomStore.js";

// Helper mock socket & io
function createMockEnvironment() {
  const emittedEvents = new Map(); // socketId -> array of { event, data }

  const io = {
    to: (targetId) => ({
      emit: (event, data) => {
        if (!emittedEvents.has(targetId)) emittedEvents.set(targetId, []);
        emittedEvents.get(targetId).push({ event, data });
      },
    }),
  };

  const createSocket = (id, roomId = null, username = "User") => {
    const handlers = new Map();
    const socket = {
      id,
      data: { roomId, username },
      on: (event, handler) => {
        handlers.set(event, handler);
      },
      emit: (event, data) => {
        if (!emittedEvents.has(id)) emittedEvents.set(id, []);
        emittedEvents.get(id).push({ event, data });
      },
      leave: () => {},
      join: () => {},
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

test("backend: p2p:request authorizes room members, registers transfer session, and sanitizes metadata", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-p2p-1";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-alice", "Alice", true);
  addMemberToRoom(roomId, "sock-bob", "Bob", false);

  const bob = createSocket("sock-bob", roomId, "Bob");

  // Bob requests file from Alice
  bob._trigger("p2p:request", {
    to: "sock-alice",
    fileName: "<script>alert(1)</script>big-video.mp4",
    fileSize: 104857600,
    unwantedProperty: "should-not-leak",
  });

  const aliceEvents = emittedEvents.get("sock-alice") || [];
  const reqEvent = aliceEvents.find((e) => e.event === "p2p:request");

  assert.ok(reqEvent, "Alice should receive p2p:request");
  assert.strictEqual(reqEvent.data.from, "sock-bob");
  assert.strictEqual(reqEvent.data.fromUsername, "Bob");
  assert.strictEqual(reqEvent.data.fileName, "<script>alert(1)</script>big-video.mp4");
  assert.strictEqual(reqEvent.data.fileSize, 104857600);
  assert.strictEqual(reqEvent.data.unwantedProperty, undefined);
});

test("backend: p2p:signal rejects unauthorized signaling across rooms or without active session", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomA = "room-a";
  const roomB = "room-b";
  getOrCreateRoom(roomA);
  getOrCreateRoom(roomB);
  addMemberToRoom(roomA, "sock-1", "User1", true);
  addMemberToRoom(roomB, "sock-2", "User2", true);

  const sock1 = createSocket("sock-1", roomA, "User1");

  // 1. Cross-room signal to sock-2
  sock1._trigger("p2p:signal", {
    to: "sock-2",
    signal: { sdp: { type: "offer", sdp: "v=0..." } },
  });
  assert.strictEqual((emittedEvents.get("sock-2") || []).length, 0, "Cross-room signal must be dropped");

  // 2. Intra-room signal without an initiated session
  addMemberToRoom(roomA, "sock-3", "User3", false);
  const sock3 = createSocket("sock-3", roomA, "User3");

  sock1._trigger("p2p:signal", {
    to: "sock-3",
    signal: { sdp: { type: "offer", sdp: "v=0..." } },
  });
  assert.strictEqual((emittedEvents.get("sock-3") || []).length, 0, "Signal without active transfer session must be dropped");
});

test("backend: p2p:signal and p2p:cancel relay authorized messages and reject unauthorized third-party cancels", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-p2p-auth";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-host", "Host", true);
  addMemberToRoom(roomId, "sock-peer", "Peer", false);
  addMemberToRoom(roomId, "sock-intruder", "Intruder", false);

  const host = createSocket("sock-host", roomId, "Host");
  const peer = createSocket("sock-peer", roomId, "Peer");
  const intruder = createSocket("sock-intruder", roomId, "Intruder");

  // Peer initiates transfer with Host
  peer._trigger("p2p:request", { to: "sock-host", fileName: "movie.mkv", fileSize: 50000 });

  // Host sends SDP offer signal to Peer (authorized session exists)
  host._trigger("p2p:signal", {
    to: "sock-peer",
    signal: { sdp: { type: "offer", sdp: "mock-sdp" } },
  });

  const peerEvents = emittedEvents.get("sock-peer") || [];
  const signalEvent = peerEvents.find((e) => e.event === "p2p:signal");
  assert.ok(signalEvent, "Peer should receive authorized signal");
  assert.strictEqual(signalEvent.data.signal.sdp.type, "offer");

  // Intruder in the same room attempts to cancel transfer between Host and Peer
  intruder._trigger("p2p:cancel", {
    to: "sock-peer",
    reason: "Malicious cancel",
  });

  const peerCancels = (emittedEvents.get("sock-peer") || []).filter((e) => e.event === "p2p:cancel");
  assert.strictEqual(peerCancels.length, 0, "Unauthorized intruder cancel must be dropped");

  // Legitimate cancellation by Peer
  peer._trigger("p2p:cancel", {
    to: "sock-host",
    reason: "User closed player",
  });

  const hostCancels = (emittedEvents.get("sock-host") || []).filter((e) => e.event === "p2p:cancel");
  assert.strictEqual(hostCancels.length, 1, "Host should receive legitimate cancellation");
  assert.strictEqual(hostCancels[0].data.reason, "User closed player");
});

test("backend: p2p:get-ice-servers returns STUN/TURN configurations", (t, done) => {
  const { createSocket } = createMockEnvironment();
  const socket = createSocket("sock-ice", "room-1", "User");

  socket._trigger("p2p:get-ice-servers", (config) => {
    assert.ok(config);
    assert.ok(Array.isArray(config.iceServers));
    assert.ok(config.iceServers.length > 0);
    assert.ok(config.iceServers.some((s) => s.urls.includes("stun:")));
    done();
  });
});

test("backend: user departure automatically cancels active P2P transfer and notifies peer", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-depart";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-alice", "Alice", true);
  addMemberToRoom(roomId, "sock-bob", "Bob", false);

  const alice = createSocket("sock-alice", roomId, "Alice");
  const bob = createSocket("sock-bob", roomId, "Bob");

  // Establish active transfer session
  bob._trigger("p2p:request", { to: "sock-alice", fileName: "movie.mp4", fileSize: 50000 });

  // Alice leaves the room
  alice._trigger("room:leave");

  // Bob should receive p2p:cancel with "Peer left the room"
  const bobEvents = emittedEvents.get("sock-bob") || [];
  const cancelEvent = bobEvents.find((e) => e.event === "p2p:cancel");
  assert.ok(cancelEvent, "Bob should receive p2p:cancel when Alice leaves");
  assert.strictEqual(cancelEvent.data.reason, "Peer left the room");
});

test("backend: p2p:signal and p2p:cancel reject invalid, missing, or self targets and malformed payloads", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-invalid-targets";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-sender", "Sender", true);
  addMemberToRoom(roomId, "sock-target", "Target", false);

  const sender = createSocket("sock-sender", roomId, "Sender");
  const unattached = createSocket("sock-unattached", null, "Unattached");

  // Caller not in any room
  unattached._trigger("p2p:signal", { to: "sock-target", signal: { sdp: { type: "offer", sdp: "mock" } } });
  unattached._trigger("p2p:cancel", { to: "sock-target", reason: "test" });

  // Null, undefined, primitive, or array payload
  sender._trigger("p2p:signal", null);
  sender._trigger("p2p:signal", undefined);
  sender._trigger("p2p:signal", "string-payload");
  sender._trigger("p2p:signal", [1, 2, 3]);
  sender._trigger("p2p:cancel", null);
  sender._trigger("p2p:cancel", undefined);
  sender._trigger("p2p:cancel", 12345);

  // Missing or non-string 'to'
  sender._trigger("p2p:signal", { signal: { sdp: { type: "offer", sdp: "mock" } } });
  sender._trigger("p2p:signal", { to: 12345, signal: { sdp: { type: "offer", sdp: "mock" } } });
  sender._trigger("p2p:signal", { to: {}, signal: { sdp: { type: "offer", sdp: "mock" } } });
  sender._trigger("p2p:cancel", { reason: "no target" });
  sender._trigger("p2p:cancel", { to: 999, reason: "number target" });

  // Empty string or whitespace 'to'
  sender._trigger("p2p:signal", { to: "", signal: { sdp: { type: "offer", sdp: "mock" } } });
  sender._trigger("p2p:signal", { to: "   ", signal: { sdp: { type: "offer", sdp: "mock" } } });
  sender._trigger("p2p:cancel", { to: "", reason: "empty target" });
  sender._trigger("p2p:cancel", { to: "  ", reason: "whitespace target" });

  // Self target
  sender._trigger("p2p:signal", { to: "sock-sender", signal: { sdp: { type: "offer", sdp: "mock" } } });
  sender._trigger("p2p:cancel", { to: "sock-sender", reason: "self cancel" });

  // Malformed signal without SDP or candidate
  sender._trigger("p2p:signal", { to: "sock-target", signal: {} });
  sender._trigger("p2p:signal", { to: "sock-target", signal: { foo: "bar" } });
  sender._trigger("p2p:signal", { to: "sock-target", signal: { sdp: { type: 123 } } });

  // Ensure nothing was emitted to target
  assert.strictEqual((emittedEvents.get("sock-target") || []).length, 0, "No invalid events should reach target");
});

test("backend: p2p:cancel rejects cross-room cancellation", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomA = "room-cancel-a";
  const roomB = "room-cancel-b";
  getOrCreateRoom(roomA);
  getOrCreateRoom(roomB);
  addMemberToRoom(roomA, "sock-a1", "Alice", true);
  addMemberToRoom(roomB, "sock-b1", "Bob", true);

  const sockA1 = createSocket("sock-a1", roomA, "Alice");

  // Attempt to cancel against peer in another room
  sockA1._trigger("p2p:cancel", {
    to: "sock-b1",
    reason: "Cross-room cancellation attempt",
  });

  const b1Events = emittedEvents.get("sock-b1") || [];
  assert.strictEqual(b1Events.length, 0, "Cross-room cancellation must be rejected");
});

test("backend: p2p:cancel terminates active session so subsequent signals and duplicate cancels are rejected", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-cancel-term";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-host", "Host", true);
  addMemberToRoom(roomId, "sock-peer", "Peer", false);

  const host = createSocket("sock-host", roomId, "Host");
  const peer = createSocket("sock-peer", roomId, "Peer");

  // Establish transfer
  peer._trigger("p2p:request", { to: "sock-host", fileName: "video.mp4", fileSize: 1000 });

  // Host cancels transfer
  host._trigger("p2p:cancel", { to: "sock-peer", reason: "Cancelled by host" });

  const peerCancels = (emittedEvents.get("sock-peer") || []).filter((e) => e.event === "p2p:cancel");
  assert.strictEqual(peerCancels.length, 1, "Peer should receive cancellation");
  assert.strictEqual(peerCancels[0].data.reason, "Cancelled by host");

  // Host tries to signal peer after cancellation
  host._trigger("p2p:signal", {
    to: "sock-peer",
    signal: { sdp: { type: "offer", sdp: "post-cancel-sdp" } },
  });

  // Peer tries to signal host after cancellation
  peer._trigger("p2p:signal", {
    to: "sock-host",
    signal: { candidate: { candidate: "candidate:post-cancel" } },
  });

  // Host tries to cancel again
  host._trigger("p2p:cancel", { to: "sock-peer", reason: "Duplicate cancel" });

  const peerSignals = (emittedEvents.get("sock-peer") || []).filter((e) => e.event === "p2p:signal");
  const hostSignals = (emittedEvents.get("sock-host") || []).filter((e) => e.event === "p2p:signal");
  assert.strictEqual(peerSignals.length, 0, "No signals should be relayed to peer after cancellation");
  assert.strictEqual(hostSignals.length, 0, "No signals should be relayed to host after cancellation");
  assert.strictEqual(
    (emittedEvents.get("sock-peer") || []).filter((e) => e.event === "p2p:cancel").length,
    1,
    "Duplicate cancel should be rejected"
  );
});

test("backend: p2p:signal supports valid bidirectional signaling of SDP and ICE candidates", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-valid-bidi";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-host", "Host", true);
  addMemberToRoom(roomId, "sock-peer", "Peer", false);

  const host = createSocket("sock-host", roomId, "Host");
  const peer = createSocket("sock-peer", roomId, "Peer");

  // Establish transfer
  peer._trigger("p2p:request", { to: "sock-host", fileName: "sample.webm", fileSize: 2048 });

  // 1. Host -> Peer SDP offer
  host._trigger("p2p:signal", {
    to: "sock-peer",
    signal: { sdp: { type: "offer", sdp: "v=0-offer" } },
  });

  // 2. Peer -> Host SDP answer
  peer._trigger("p2p:signal", {
    to: "sock-host",
    signal: { sdp: { type: "answer", sdp: "v=0-answer" } },
  });

  // 3. Host -> Peer ICE candidate (object)
  host._trigger("p2p:signal", {
    to: "sock-peer",
    signal: { candidate: { candidate: "candidate:1", sdpMid: "0" } },
  });

  // 4. Peer -> Host ICE candidate (string)
  peer._trigger("p2p:signal", {
    to: "sock-host",
    signal: { candidate: "candidate:2" },
  });

  const peerEvents = (emittedEvents.get("sock-peer") || []).filter((e) => e.event === "p2p:signal");
  const hostEvents = (emittedEvents.get("sock-host") || []).filter((e) => e.event === "p2p:signal");

  assert.strictEqual(peerEvents.length, 2, "Peer should receive 2 signals (offer + ICE candidate)");
  assert.strictEqual(peerEvents[0].data.signal.sdp.type, "offer");
  assert.strictEqual(peerEvents[1].data.signal.candidate.candidate, "candidate:1");

  assert.strictEqual(hostEvents.length, 2, "Host should receive 2 signals (answer + ICE candidate)");
  assert.strictEqual(hostEvents[0].data.signal.sdp.type, "answer");
  assert.strictEqual(hostEvents[1].data.signal.candidate, "candidate:2");
});

test("backend: user departure cleans up transfers even when the departing user is the last remaining member", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-depart-last";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-single", "SoloUser", true);

  const user = createSocket("sock-single", roomId, "SoloUser");

  // User departs when sole member of room
  user._trigger("room:leave");

  // Verify no crash and room is cleaned up
  assert.strictEqual(emittedEvents.get("sock-single")?.length || 0, 0);
});

test("backend: guest can share file, setting mediaOwnerSocketId and routing p2p:request without explicit target", () => {
  const { createSocket, emittedEvents } = createMockEnvironment();
  const roomId = "room-guest-share";
  getOrCreateRoom(roomId);
  addMemberToRoom(roomId, "sock-host", "HostUser", true);
  addMemberToRoom(roomId, "sock-guest", "GuestUser", false);
  addMemberToRoom(roomId, "sock-viewer", "ViewerUser", false);

  const host = createSocket("sock-host", roomId, "HostUser");
  const guest = createSocket("sock-guest", roomId, "GuestUser");
  const viewer = createSocket("sock-viewer", roomId, "ViewerUser");

  // 1. Guest emits change_source with a local video file
  guest._trigger("media:action", {
    action: "change_source",
    mediaType: "file",
    mediaMetadata: {
      fileName: "guest-movie.mp4",
      fileSize: 52428800,
      fileType: "video/mp4",
    },
  });

  // Verify room:state was broadcast to room with guest as mediaOwner
  const roomEvents = emittedEvents.get(roomId) || [];
  const stateEvent = roomEvents.find((e) => e.event === "room:state");
  assert.ok(stateEvent, "Room state should be broadcast");
  assert.strictEqual(stateEvent.data.mediaOwnerSocketId, "sock-guest");
  assert.strictEqual(stateEvent.data.mediaOwnerUsername, "GuestUser");
  assert.strictEqual(stateEvent.data.mediaMetadata.ownerSocketId, "sock-guest");
  assert.strictEqual(stateEvent.data.mediaMetadata.fileName, "guest-movie.mp4");

  // 2. Viewer sends p2p:request with omitted `to` field -> must route to sock-guest, NOT sock-host
  viewer._trigger("p2p:request", {
    fileName: "guest-movie.mp4",
    fileSize: 52428800,
  });

  const guestEvents = emittedEvents.get("sock-guest") || [];
  const reqEvent = guestEvents.find((e) => e.event === "p2p:request");
  assert.ok(reqEvent, "Guest should receive p2p:request as the designated mediaOwner");
  assert.strictEqual(reqEvent.data.from, "sock-viewer");

  // Host should NOT have received the request
  const hostEvents = emittedEvents.get("sock-host") || [];
  const hostReq = hostEvents.find((e) => e.event === "p2p:request");
  assert.strictEqual(hostReq, undefined, "Host should not receive download request for guest's file");
});
