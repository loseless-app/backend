import test from "node:test";
import assert from "node:assert/strict";
import { io as ioc } from "socket.io-client";

const SERVER_URL = "http://localhost:4000";

function createClientSocket() {
  return ioc(SERVER_URL, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
}

function waitForEvent(socket, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

test("E2E P2P Transfer Signaling & State Sync over live server", async () => {
  const sender = createClientSocket();
  const receiver = createClientSocket();

  try {
    const roomId = `e2e-p2p-${Date.now()}`;

    // 1. Sender creates room
    sender.emit("room:join", {
      roomId,
      username: "AliceHost",
      isCreating: true,
    });
    const senderJoinAck = await waitForEvent(sender, "room:joined");
    assert.strictEqual(senderJoinAck.roomId, roomId);

    // 2. Receiver joins room
    receiver.emit("room:join", {
      roomId,
      username: "BobReceiver",
      isCreating: false,
    });
    const receiverJoinAck = await waitForEvent(receiver, "room:joined");
    assert.strictEqual(receiverJoinAck.roomId, roomId);
    await waitForEvent(receiver, "room:state"); // Consume initial room state

    // 3. Sender selects a local file and broadcasts change_source
    sender.emit("media:action", {
      action: "change_source",
      mediaType: "file",
      mediaMetadata: {
        fileName: "vacation-video.mp4",
        fileSize: 104857600,
        fileType: "video/mp4",
      },
    });

    // 4. Receiver receives updated room:state with mediaOwnerSocketId pointing to sender
    const statePromise = waitForEvent(receiver, "room:state");
    const roomState = await statePromise;
    assert.strictEqual(roomState.mediaType, "file");
    assert.strictEqual(roomState.mediaMetadata.fileName, "vacation-video.mp4");
    assert.strictEqual(roomState.mediaOwnerSocketId, sender.id);
    assert.strictEqual(roomState.mediaMetadata.ownerSocketId, sender.id);

    // 5. Receiver requests file transfer via p2p:request
    receiver.emit("p2p:request", {
      to: roomState.mediaOwnerSocketId,
      fileName: roomState.mediaMetadata.fileName,
      fileSize: roomState.mediaMetadata.fileSize,
    });

    // 6. Sender receives p2p:request
    const reqPromise = waitForEvent(sender, "p2p:request");
    const p2pReq = await reqPromise;
    assert.strictEqual(p2pReq.from, receiver.id);
    assert.strictEqual(p2pReq.fileName, "vacation-video.mp4");
    assert.strictEqual(p2pReq.fileSize, 104857600);

    // 7. Sender sends SDP offer to receiver via p2p:signal
    sender.emit("p2p:signal", {
      to: receiver.id,
      signal: {
        sdp: { type: "offer", sdp: "v=0\r\no=alice 1234 1 IN IP4 127.0.0.1\r\ns=-\r\n" },
      },
    });

    const offerSignal = await waitForEvent(receiver, "p2p:signal");
    assert.strictEqual(offerSignal.from, sender.id);
    assert.strictEqual(offerSignal.signal.sdp.type, "offer");

    // 8. Receiver sends SDP answer to sender via p2p:signal
    receiver.emit("p2p:signal", {
      to: sender.id,
      signal: {
        sdp: { type: "answer", sdp: "v=0\r\no=bob 5678 1 IN IP4 127.0.0.1\r\ns=-\r\n" },
      },
    });

    const answerSignal = await waitForEvent(sender, "p2p:signal");
    assert.strictEqual(answerSignal.from, receiver.id);
    assert.strictEqual(answerSignal.signal.sdp.type, "answer");

    // 9. ICE candidate exchange
    sender.emit("p2p:signal", {
      to: receiver.id,
      signal: {
        candidate: { candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host", sdpMid: "0" },
      },
    });

    const candidateSignal = await waitForEvent(receiver, "p2p:signal");
    assert.strictEqual(candidateSignal.from, sender.id);
    assert.ok(candidateSignal.signal.candidate);

  } finally {
    sender.disconnect();
    receiver.disconnect();
  }
});

test("E2E P2P Transfer Stale / Fallback Routing over live server", async () => {
  const sender = createClientSocket();
  const receiver = createClientSocket();

  try {
    const roomId = `e2e-fallback-${Date.now()}`;

    sender.emit("room:join", { roomId, username: "AliceHost", isCreating: true });
    await waitForEvent(sender, "room:joined");

    receiver.emit("room:join", { roomId, username: "BobReceiver", isCreating: false });
    await waitForEvent(receiver, "room:joined");

    sender.emit("media:action", {
      action: "change_source",
      mediaType: "file",
      mediaMetadata: {
        fileName: "movie.mp4",
        fileSize: 5000000,
        fileType: "video/mp4",
      },
    });
    await waitForEvent(receiver, "room:state");

    // Bob sends p2p:request with stale socket ID; server must fall back to mediaOwnerSocketId (Alice)
    receiver.emit("p2p:request", {
      to: "stale-socket-that-does-not-exist",
      fileName: "movie.mp4",
      fileSize: 5000000,
    });

    const p2pReq = await waitForEvent(sender, "p2p:request");
    assert.strictEqual(p2pReq.from, receiver.id);
    assert.strictEqual(p2pReq.fileName, "movie.mp4");

  } finally {
    sender.disconnect();
    receiver.disconnect();
  }
});

test("E2E P2P Transfer Cancellation & User Departure over live server", async () => {
  const host = createClientSocket();
  const guestSender = createClientSocket();
  const guestReceiver = createClientSocket();

  try {
    const roomId = `e2e-cancel-${Date.now()}`;

    // 1. Host creates room
    host.emit("room:join", { roomId, username: "RoomHost", isCreating: true });
    await waitForEvent(host, "room:joined");

    // 2. GuestSender joins room
    guestSender.emit("room:join", { roomId, username: "GuestFileOwner", isCreating: false });
    await waitForEvent(guestSender, "room:joined");

    // 3. GuestReceiver joins room
    guestReceiver.emit("room:join", { roomId, username: "GuestDownloader", isCreating: false });
    await waitForEvent(guestReceiver, "room:joined");
    await waitForEvent(guestReceiver, "room:state");

    // 4. GuestSender selects local file
    guestSender.emit("media:action", {
      action: "change_source",
      mediaType: "file",
      mediaMetadata: {
        fileName: "guest-clip.mp4",
        fileSize: 20480000,
        fileType: "video/mp4",
      },
    });

    const stateUpdate = await waitForEvent(guestReceiver, "room:state");
    assert.strictEqual(stateUpdate.mediaOwnerSocketId, guestSender.id);
    assert.strictEqual(stateUpdate.mediaMetadata.fileName, "guest-clip.mp4");

    // 5. GuestReceiver requests file from GuestSender
    guestReceiver.emit("p2p:request", {
      to: guestSender.id,
      fileName: "guest-clip.mp4",
      fileSize: 20480000,
    });

    const reqReceived = await waitForEvent(guestSender, "p2p:request");
    assert.strictEqual(reqReceived.from, guestReceiver.id);

    // 6. GuestSender cancels transfer (e.g. peer has no file or user clicked cancel)
    guestSender.emit("p2p:cancel", {
      to: guestReceiver.id,
      reason: "User cancelled upload",
    });

    const cancelReceived = await waitForEvent(guestReceiver, "p2p:cancel");
    assert.strictEqual(cancelReceived.from, guestSender.id);
    assert.strictEqual(cancelReceived.reason, "User cancelled upload");

    // 7. Test user departure clean-up: start new transfer session then GuestSender disconnects
    guestReceiver.emit("p2p:request", {
      to: guestSender.id,
      fileName: "guest-clip.mp4",
      fileSize: 20480000,
    });
    await waitForEvent(guestSender, "p2p:request");

    // GuestSender leaves the room
    guestSender.emit("room:leave");

    // GuestReceiver should be notified that peer left / transfer cancelled
    const userLeftCancel = await waitForEvent(guestReceiver, "p2p:cancel");
    assert.ok(userLeftCancel, "GuestReceiver must be notified when sender departs");
    assert.match(userLeftCancel.reason, /left the room/i);

  } finally {
    host.disconnect();
    guestSender.disconnect();
    guestReceiver.disconnect();
  }
});

