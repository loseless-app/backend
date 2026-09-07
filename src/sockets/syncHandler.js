import {
  getRoom,
  addMemberToRoom,
  removeMemberFromRoom,
  updateRoomState,
  serializeRoom,
} from "../stores/roomStore.js";
import { parseMediaUrl } from "../utils/urlParser.js";

// Register all WebSocket event handlers for a client connection
export function registerSyncHandlers(io, socket) {

  // NTP ping-pong for clock skew calculation
  socket.on("sync:ping", (payload) => {
    const clientSendTime = payload?.clientSendTime || 0;
    socket.emit("sync:pong", {
      clientSendTime,
      serverTime: Date.now(),
    });
  });

  // Handle room join request
  socket.on("room:join", (payload) => {
    const { roomId, username } = payload || {};

    if (!roomId || !username) {
      return socket.emit("error", { message: "roomId and username are required." });
    }
    
    // Attach socket to room channel
    socket.join(roomId);

    // Save room and user metadata on socket instance for disconnect cleanup
    socket.data.roomId = roomId;
    socket.data.username = username;

    // Add user to memory room store
    const { room, member } = addMemberToRoom(roomId, socket.id, username);

    // Send current room state to joining user
    socket.emit("room:state", serializeRoom(room));

    // Broadcast user joined event to other room members
    socket.to(roomId).emit("room:user_joined", {
      username: member.username,
      totalUsers: room.members.size,
      members: serializeRoom(room).members,
    });
  });

  // Handle media actions: play, pause, seek, change_source
  socket.on("media:action", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    const { action, position = 0, mediaType, mediaUrl } = payload || {};
    const now = Date.now();

    let stateUpdates = {};

    switch (action) {
      case "play":
        stateUpdates = {
          isPlaying: true,
          anchorTime: position,
          lastStartedAt: now,
          isBuffering: false,
          bufferingUser: null,
        };
        break;

      case "pause":
        stateUpdates = {
          isPlaying: false,
          anchorTime: position,
          lastStartedAt: now,
          isBuffering: false,
          bufferingUser: null,
        };
        break;

      case "seek":
        stateUpdates = {
          anchorTime: position,
          lastStartedAt: now,
        };
        break;

      case "change_source": {
        const parsed = parseMediaUrl(mediaUrl || "");
        stateUpdates = {
          mediaType: mediaType || parsed.provider || "url",
          mediaUrl: parsed.canonicalUrl || mediaUrl || "",
          mediaProvider: parsed.provider,
          mediaId: parsed.mediaId,
          embedUrl: parsed.embedUrl,
          isPlaying: false,
          anchorTime: 0,
          lastStartedAt: now,
          isBuffering: false,
          bufferingUser: null,
        };
        break;
      }

      default:
        return;
    }

    // Update room state in RAM
    const updatedRoom = updateRoomState(roomId, stateUpdates);

    // Broadcast updated state to everyone in the room
    io.to(roomId).emit("room:state", serializeRoom(updatedRoom));
  });

  // Handle live media reactions (e.g. fire, heart, laugh)
  socket.on("media:reaction", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const username = socket.data.username || "Peer";
    const emoji = payload?.emoji || "🔥";

    io.to(roomId).emit("media:reaction", {
      emoji,
      username,
      timestamp: Date.now(),
    });
  });

  // Handle live room chat messages
  socket.on("chat:message", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const username = socket.data.username || "Peer";
    const text = (payload?.text || "").trim();

    if (!text) return;

    const messageObj = {
      id: Math.random().toString(36).substring(2, 9),
      username,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    io.to(roomId).emit("chat:message", messageObj);
  });

  // Handle member buffering status change
  socket.on("media:buffering", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    const { isBuffering } = payload || {};
    const username = socket.data.username || "Peer";

    const stateUpdates = {
      isBuffering: !!isBuffering,
      bufferingUser: isBuffering ? username : null,
    };

    const updatedRoom = updateRoomState(roomId, stateUpdates);
    io.to(roomId).emit("room:state", serializeRoom(updatedRoom));
  });

  // Handle socket disconnect cleanup
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const socketId = socket.id;

    if (!roomId) return;

    const result = removeMemberFromRoom(roomId, socketId);
    if (!result || result.roomDeleted) return;

    const room = getRoom(roomId);
    if (room) {
      io.to(roomId).emit("room:user_left", {
        socketId,
        totalUsers: room.members.size,
        members: serializeRoom(room).members,
      });
      // Broadcast updated room state in case host migration occurred
      io.to(roomId).emit("room:state", serializeRoom(room));
    }
  });
}
