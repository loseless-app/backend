import {
  getRoom,
  addMemberToRoom,
  removeMemberFromRoom,
  updateRoomState,
  serializeRoom,
} from "../stores/roomStore.js";
import { parseMediaUrl } from "../utils/urlParser.js";
import { saveMessage, getRecentMessages } from "../stores/chatStore.js";

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

    // Send recent chat history to the joining user (best-effort)
    getRecentMessages(roomId, 50).then((history) => {
      socket.emit("chat:history", history);
    });

    // Broadcast user joined event to other room members
    socket.to(roomId).emit("room:user_joined", {
      username: member.username,
      totalUsers: room.members.size,
      members: serializeRoom(room).members,
    });

    // Broadcast system chat notification for user joined
    socket.to(roomId).emit("chat:message", {
      id: `sys-join-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      type: "system",
      systemType: "user_joined",
      username: member.username,
      text: `${member.username} joined the room`,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  });

  // Handle media actions: play, pause, seek, change_source
  socket.on("media:action", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    const { action, position = 0, mediaType, mediaUrl, mediaMetadata } = payload || {};
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
          isBuffering: false,
          bufferingUser: null,
        };
        break;

      case "change_source": {
        if (mediaType === "file") {
          stateUpdates = {
            mediaType: "file",
            mediaUrl: null, // Critical: never broadcast client-private blob URLs
            mediaProvider: "file",
            mediaId: mediaMetadata?.fileName || "local_file",
            embedUrl: null,
            mediaMetadata: mediaMetadata || null,
            isPlaying: false,
            anchorTime: 0,
            lastStartedAt: now,
            isBuffering: false,
            bufferingUser: null,
          };
        } else {
          const parsed = parseMediaUrl(mediaUrl || "");
          stateUpdates = {
            mediaType: mediaType || parsed.provider || "url",
            mediaUrl: parsed.canonicalUrl || mediaUrl || "",
            mediaProvider: parsed.provider,
            mediaId: parsed.mediaId,
            embedUrl: parsed.embedUrl,
            mediaMetadata: null, // Reset file metadata when switching to URL mode
            isPlaying: false,
            anchorTime: 0,
            lastStartedAt: now,
            isBuffering: false,
            bufferingUser: null,
          };
        }
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

    // Persist to MongoDB (best-effort: real-time chat must not depend on DB)
    saveMessage(roomId, username, text);

    io.to(roomId).emit("chat:message", messageObj);
  });

  // Handle member buffering status change
  socket.on("media:buffering", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || room.mediaType === "file") return;

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

    const username = socket.data.username;
    const result = removeMemberFromRoom(roomId, socketId);
    if (!result || result.roomDeleted) return;

    const room = getRoom(roomId);
    if (room) {
      io.to(roomId).emit("room:user_left", {
        socketId,
        username,
        totalUsers: room.members.size,
        members: serializeRoom(room).members,
      });

      if (username) {
        socket.to(roomId).emit("chat:message", {
          id: `sys-leave-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          type: "system",
          systemType: "user_left",
          username,
          text: `${username} left the room`,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      }

      // Broadcast updated room state in case host migration occurred
      io.to(roomId).emit("room:state", serializeRoom(room));
    }
  });
}
