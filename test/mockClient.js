import { io } from "socket.io-client";

const SERVER_URL = "http://localhost:4000";
const ROOM_ID = "test-room-101";

console.log("Starting Tri-Modal Watch Party Integration Test...\n");

// Connect Host client (Alice)
const alice = io(SERVER_URL, { transports: ["websocket"] });

alice.on("connect", () => {
  console.log("Alice connected with Socket ID:", alice.id);

  // 1. Test NTP Clock Sync
  const t0 = Date.now();
  alice.emit("sync:ping", { clientSendTime: t0 });

  alice.on("sync:pong", (data) => {
    const rtt = Date.now() - data.clientSendTime;
    console.log(`NTP Sync Success! Round-Trip Time: ${rtt}ms, Server Time: ${data.serverTime}`);
    
    // 2. Alice joins room
    alice.emit("room:join", { roomId: ROOM_ID, username: "Alice" });
  });
});

alice.on("room:state", (state) => {
  const aliceMember = state.members.find((m) => m.username === "Alice");
  if (aliceMember?.isHost && state.members.length === 1) {
    console.log("Alice assigned Host status");

    // 3. Connect Peer client (Bob)
    connectBob();
  }
});

function connectBob() {
  const bob = io(SERVER_URL, { transports: ["websocket"] });

  bob.on("connect", () => {
    console.log("Bob connected with Socket ID:", bob.id);
    bob.emit("room:join", { roomId: ROOM_ID, username: "Bob" });
  });

  bob.on("room:state", (state) => {
    if (state.members.length === 2 && !bob.data?.testStarted) {
      if (!bob.data) bob.data = {};
      bob.data.testStarted = true;

      console.log("Both Alice and Bob in room. Total members:", state.members.length);

      // 4. Test Media Action: Alice clicks Play at 12.5s
      console.log("Alice triggers Play action at 12.5 seconds...");
      alice.emit("media:action", {
        action: "play",
        position: 12.5,
        mediaType: "url",
        mediaUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      });
    }

    // Verify Bob received Alice's Play action
    if (state.isPlaying && state.anchorTime === 12.5 && !bob.data?.bufferedTested) {
      bob.data.bufferedTested = true;
      console.log("Bob received state broadcast. isPlaying: true, anchorTime:", state.anchorTime);

      // 5. Test Buffering: Bob sends buffering lock
      console.log("Bob triggers Buffering lock...");
      bob.emit("client:buffering", { isBuffering: true });
    }

    // Verify Bob received Host status after Alice disconnects
    if (bob.data?.aliceDisconnected && state.members.length === 1) {
      const bobMember = state.members.find((m) => m.username === "Bob");
      if (bobMember?.isHost) {
        console.log("Host Migration Success! Bob is now the new Host");
        console.log("\nALL TESTS PASSED SUCCESSFULLY");

        bob.disconnect();
        process.exit(0);
      }
    }
  });

  alice.on("room:buffering_state", (bufferingData) => {
    if (bufferingData.isBuffering && bufferingData.username === "Bob") {
      console.log("Alice received Bob's buffering lock");

      // 6. Test Host Migration: Alice disconnects
      console.log("Alice disconnects from room...");
      if (!bob.data) bob.data = {};
      bob.data.aliceDisconnected = true;
      alice.disconnect();
    }
  });
}
