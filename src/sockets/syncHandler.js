import {
  getRoom,
  addMemberToRoom,
  reconnectMember,
  removeMemberFromRoom,
  updateRoomState,
  serializeRoom,
  disambiguateUsername,
} from "../stores/roomStore.js";
import crypto from "node:crypto";
import { parseMediaUrl } from "../utils/urlParser.js";
import { saveMessage, getRecentMessages } from "../stores/chatStore.js";

// Tracks disconnect grace periods: Key = `${roomId}:${sessionId || username}`, Value = { timer, socketId, roomId, username, sessionId }
const pendingDisconnects = new Map();
const RECONNECT_GRACE_PERIOD_MS = 5000;

// Tracks authorized active P2P transfers between peers in a room: Key = `${roomId}:${[id1, id2].sort().join(":")}`
const activeP2PTransfers = new Map();

function getP2PTransferKey(roomId, id1, id2) {
  const sortedIds = [id1, id2].sort();
  return `${roomId}:${sortedIds[0]}:${sortedIds[1]}`;
}

/**
 * Authorizes a P2P signaling or cancellation action between the caller and a target peer.
 * Validates:
 * 1. Caller is attached to an active roomId.
 * 2. Room exists in the room store and caller is an active member.
 * 3. Target socketId is valid (non-empty string, trimmed, not self).
 * 4. Target socket belongs to the same room.
 * 5. An active, authorized P2P transfer session exists between caller and target.
 *
 * @param {object} socket - Caller socket instance
 * @param {string} targetSocketId - Target socket ID
 * @returns {{ authorized: boolean, roomId?: string, transferKey?: string, targetSocketId?: string, reason?: string }}
 */
function authorizeP2PTransferPeer(socket, targetSocketId) {
  const roomId = socket?.data?.roomId;
  if (!roomId) {
    return { authorized: false, reason: "CALLER_NOT_IN_ROOM" };
  }

  const room = getRoom(roomId);
  if (!room || !room.members.has(socket.id)) {
    return { authorized: false, reason: "CALLER_NOT_ROOM_MEMBER" };
  }

  if (typeof targetSocketId !== "string" || !targetSocketId.trim() || targetSocketId.trim() === socket.id) {
    return { authorized: false, reason: "INVALID_TARGET" };
  }

  const cleanTargetId = targetSocketId.trim();

  if (!room.members.has(cleanTargetId)) {
    return { authorized: false, reason: "TARGET_NOT_IN_ROOM" };
  }

  const transferKey = getP2PTransferKey(roomId, socket.id, cleanTargetId);
  if (!activeP2PTransfers.has(transferKey)) {
    return { authorized: false, reason: "NO_ACTIVE_TRANSFER" };
  }

  return { authorized: true, roomId, transferKey, targetSocketId: cleanTargetId };
}

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
  socket.on("room:join", (payload, callback) => {
    const { roomId, username, sessionId, isCreating } = payload || {};

    if (!roomId || !username) {
      if (typeof callback === "function") {
        callback({ success: false, error: "roomId and username are required." });
      }
      return socket.emit("error", { message: "roomId and username are required." });
    }

    // Primary disconnect key: if sessionId is provided, use `${roomId}:${sessionId}`.
    // Fall back to `${roomId}:${username}` for legacy/un-sessioned clients.
    const disconnectKey = sessionId ? `${roomId}:${sessionId}` : `${roomId}:${username}`;
    const pending = pendingDisconnects.get(disconnectKey);
    const existingRoom = getRoom(roomId);

    // 1. Idempotent re-join: if socket is already in this room, acknowledge immediately
    if (existingRoom && existingRoom.members.has(socket.id)) {
      const existingMember = existingRoom.members.get(socket.id);
      socket.emit("room:joined", {
        roomId,
        username: existingMember.username,
        sessionId: existingMember.sessionId,
        isHost: existingMember.isHost,
        isReconnect: true,
      });
      socket.emit("room:state", serializeRoom(existingRoom));
      if (typeof callback === "function") {
        callback({
          success: true,
          isReconnect: true,
          username: existingMember.username,
          sessionId: existingMember.sessionId,
        });
      }
      return;
    }

    // 2. If joining an existing room, verify that the room actually exists
    if (!isCreating && !existingRoom && !pending) {
      if (typeof callback === "function") {
        return callback({
          success: false,
          code: "ROOM_NOT_FOUND",
          error: "Room not found. Please check the room code and try again.",
        });
      }
      return socket.emit("room:error", {
        code: "ROOM_NOT_FOUND",
        message: "Room not found. Please check the room code and try again.",
      });
    }

    // 3. If explicitly creating a new room, prevent collision with an existing active room (unless it is self)
    if (isCreating && existingRoom && existingRoom.members.size > 0 && !existingRoom.members.has(socket.id)) {
      if (typeof callback === "function") {
        return callback({
          success: false,
          code: "ROOM_ALREADY_EXISTS",
          error: "Room ID collision. Please generate a new room code.",
        });
      }
      return socket.emit("room:error", {
        code: "ROOM_ALREADY_EXISTS",
        message: "Room ID collision.",
      });
    }

    // Attach socket to room channel
    socket.join(roomId);

    if (pending) {
      // User reconnected within the 5-second grace period!
      clearTimeout(pending.timer);
      pendingDisconnects.delete(disconnectKey);

      const result = reconnectMember(roomId, pending.socketId, socket.id, sessionId);
      if (result) {
        const { room, member } = result;

        // Terminate and notify any stale active P2P transfers tied to the previous socketId
        for (const [key, session] of activeP2PTransfers.entries()) {
          if (session.roomId === roomId && (session.requester === pending.socketId || session.target === pending.socketId)) {
            const otherPeer = session.requester === pending.socketId ? session.target : session.requester;
            io.to(otherPeer).emit("p2p:cancel", {
              from: pending.socketId,
              reason: "Peer reconnected with new session",
            });
            activeP2PTransfers.delete(key);
          }
        }

        socket.data.roomId = roomId;
        socket.data.username = member.username;
        socket.data.sessionId = sessionId;

        // Acknowledge reconnection to client with their established username
        socket.emit("room:joined", {
          roomId,
          username: member.username,
          sessionId: member.sessionId,
          isHost: member.isHost,
          isReconnect: true,
        });

        // Send current room state to reconnected user
        socket.emit("room:state", serializeRoom(room));

        // Send recent chat history
        getRecentMessages(roomId, 50).then((history) => {
          socket.emit("chat:history", history);
        });

        // Broadcast updated room state to sync socket ID / members list without spamming join messages
        io.to(roomId).emit("room:state", serializeRoom(room));
        if (typeof callback === "function") {
          callback({
            success: true,
            isReconnect: true,
            username: member.username,
            sessionId: member.sessionId,
          });
        }
        return;
      }
    }

    // Check if another active tab already holds this sessionId (Multi-tab takeover)
    if (existingRoom && sessionId) {
      let displacedSocketId = null;
      let displacedMember = null;

      for (const [memberSocketId, member] of existingRoom.members.entries()) {
        if (memberSocketId !== socket.id && member.sessionId === sessionId) {
          displacedSocketId = memberSocketId;
          displacedMember = member;
          break;
        }
      }

      if (displacedSocketId && displacedMember) {
        // If room is actively playing, cleanly pause it at current timestamp so the new tab takes over without autoplay rejection
        if (existingRoom.isPlaying) {
          const now = Date.now();
          const elapsed = existingRoom.lastStartedAt > 0 ? (now - existingRoom.lastStartedAt) / 1000 : 0;
          const currentPosition = (existingRoom.anchorTime || 0) + elapsed;

          updateRoomState(roomId, {
            isPlaying: false,
            anchorTime: currentPosition,
            lastStartedAt: now,
            isBuffering: false,
            bufferingUser: null,
          });
        }

        // Detach old socket from room channel so it stops receiving sync broadcasts
        const oldSocket = io.sockets.sockets.get(displacedSocketId);
        if (oldSocket) {
          // Direct socket emit guarantees delivery to the specific displaced tab
          oldSocket.emit("session:displaced", {
            roomId,
            message: "Room is active in another tab.",
          });
          oldSocket.leave(roomId);
          oldSocket.data.roomId = null;
          oldSocket.data.username = null;
          oldSocket.data.sessionId = null;
        } else {
          io.to(displacedSocketId).emit("session:displaced", {
            roomId,
            message: "Room is active in another tab.",
          });
        }

        // Reconnect this socket to inherit the member's name and host status
        const result = reconnectMember(roomId, displacedSocketId, socket.id, sessionId);
        if (result) {
          const { room: updatedRoom, member: currentMember } = result;

          socket.data.roomId = roomId;
          socket.data.username = currentMember.username;
          socket.data.sessionId = sessionId;

          socket.emit("room:joined", {
            roomId,
            username: currentMember.username,
            sessionId: currentMember.sessionId,
            isHost: currentMember.isHost,
            isReconnect: true,
          });

          socket.emit("room:state", serializeRoom(updatedRoom));

          getRecentMessages(roomId, 50).then((history) => {
            socket.emit("chat:history", history);
          });

          // Sync updated socket ID in member list across room without join spam
          io.to(roomId).emit("room:state", serializeRoom(updatedRoom));
          if (typeof callback === "function") {
            callback({
              success: true,
              isReconnect: true,
              username: currentMember.username,
              sessionId: currentMember.sessionId,
            });
          }
          return;
        }
      }
    }

    // New member join: Auto-disambiguate username if already taken (excluding self)
    const assignedUsername = disambiguateUsername(roomId, username, sessionId, socket.id, pendingDisconnects);

    // Save room and user metadata on socket instance for disconnect cleanup
    socket.data.roomId = roomId;
    socket.data.username = assignedUsername;
    socket.data.sessionId = sessionId;

    // Add user to memory room store
    const { room, member } = addMemberToRoom(roomId, socket.id, assignedUsername, sessionId);

    // Acknowledge join to client with their assigned username
    socket.emit("room:joined", {
      roomId,
      username: member.username,
      sessionId: member.sessionId,
      isHost: member.isHost,
      isReconnect: false,
    });

    // Broadcast updated room state to all members in the room (including joining user)
    io.to(roomId).emit("room:state", serializeRoom(room));

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

    if (typeof callback === "function") {
      callback({
        success: true,
        isReconnect: false,
        username: member.username,
        sessionId: member.sessionId,
      });
    }
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
        const ownerSocketId = socket.id;
        const ownerUsername = socket.data?.username || "Peer";

        if (mediaType === "file") {
          const augmentedMetadata =
            mediaMetadata && typeof mediaMetadata === "object"
              ? {
                  ...mediaMetadata,
                  ownerSocketId,
                  ownerUsername,
                }
              : null;

          stateUpdates = {
            mediaType: "file",
            mediaUrl: null, // Critical: never broadcast client-private blob URLs
            mediaProvider: "file",
            mediaId: mediaMetadata?.fileName || "local_file",
            embedUrl: null,
            mediaMetadata: augmentedMetadata,
            mediaOwnerSocketId: ownerSocketId,
            mediaOwnerUsername: ownerUsername,
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
            mediaOwnerSocketId: ownerSocketId,
            mediaOwnerUsername: ownerUsername,
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

  // Handle peer offering a different file while a video is playing
  socket.on("file:announce", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.members.has(socket.id)) return;

    if (!payload || typeof payload !== "object") return;

    const { fileName, fileSize, fileType } = payload;
    if (!fileName || typeof fileName !== "string") return;

    const safeFileName = fileName.slice(0, 255);
    const safeFileSize =
      typeof fileSize === "number" && Number.isSafeInteger(fileSize) && fileSize > 0
        ? fileSize
        : null;

    io.to(roomId).emit("file:offered", {
      senderSocketId: socket.id,
      senderUsername: socket.data.username || "Peer",
      fileName: safeFileName,
      fileSize: safeFileSize,
      fileType: typeof fileType === "string" ? fileType.slice(0, 100) : "video/mp4",
      timestamp: Date.now(),
    });
  });

  // Handle peer cancelling an offered file
  socket.on("file:cancel_offer", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    io.to(roomId).emit("file:offer_cancelled", {
      senderSocketId: socket.id,
    });
  });

  // Handle peer declining / rejecting an offered file
  socket.on("file:reject_offer", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.members.has(socket.id)) return;

    const senderSocketId = payload?.senderSocketId;
    if (!senderSocketId || !room.members.has(senderSocketId)) return;

    io.to(senderSocketId).emit("file:offer_rejected", {
      receiverSocketId: socket.id,
      receiverUsername: socket.data.username || "A member",
      fileName: typeof payload?.fileName === "string" ? payload.fileName.slice(0, 255) : null,
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

  // Handle P2P WebRTC signaling relay for direct peer-to-peer file transfer
  socket.on("p2p:request", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.members.has(socket.id)) return;

    if (!payload || typeof payload !== "object") return;

    let targetSocketId = payload.to;
    if (!targetSocketId || typeof targetSocketId !== "string" || !room.members.has(targetSocketId)) {
      // Default to the media owner if present and in the room, otherwise default to the room host
      if (room.mediaOwnerSocketId && room.members.has(room.mediaOwnerSocketId)) {
        targetSocketId = room.mediaOwnerSocketId;
      } else {
        for (const member of room.members.values()) {
          if (member.isHost) {
            targetSocketId = member.socketId;
            break;
          }
        }
      }
    }

    // Verify recipient exists, is in the same room, and is not the sender
    if (!targetSocketId || targetSocketId === socket.id || !room.members.has(targetSocketId)) {
      socket.emit("p2p:cancel", {
        from: targetSocketId || "unknown",
        reason: "File sender is not available in the room",
      });
      return;
    }

    // Register authorized transfer session between requester and target in this room
    const transferKey = getP2PTransferKey(roomId, socket.id, targetSocketId);
    activeP2PTransfers.set(transferKey, {
      roomId,
      requester: socket.id,
      target: targetSocketId,
      createdAt: Date.now(),
    });

    // Sanitize metadata to prevent leaking excessive or malformed data
    const safeFileName = typeof payload.fileName === "string" ? payload.fileName.slice(0, 255) : null;
    const safeFileSize = typeof payload.fileSize === "number" && Number.isSafeInteger(payload.fileSize) && payload.fileSize > 0
      ? payload.fileSize
      : null;

    io.to(targetSocketId).emit("p2p:request", {
      from: socket.id,
      fromUsername: socket.data.username || "Peer",
      fileName: safeFileName,
      fileSize: safeFileSize,
    });
  });

  socket.on("p2p:signal", (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    const { to, signal } = payload;
    if (!signal || typeof signal !== "object") return;

    // Validate signal structure: must contain either sdp or candidate
    const hasValidSdp = signal.sdp && typeof signal.sdp === "object" && typeof signal.sdp.type === "string";
    const hasValidCandidate = signal.candidate && (typeof signal.candidate === "object" || typeof signal.candidate === "string");
    if (!hasValidSdp && !hasValidCandidate) return;

    // Authorize caller, recipient, room membership, and active transfer session
    const auth = authorizeP2PTransferPeer(socket, to);
    if (!auth.authorized) {
      console.warn(`[syncHandler] Unauthorized p2p:signal rejected from ${socket.id} to ${to}: ${auth.reason}`);
      return;
    }

    io.to(auth.targetSocketId).emit("p2p:signal", {
      from: socket.id,
      signal: {
        ...(hasValidSdp ? { sdp: { type: signal.sdp.type, sdp: signal.sdp.sdp } } : {}),
        ...(hasValidCandidate ? { candidate: signal.candidate } : {}),
      },
    });
  });

  socket.on("p2p:cancel", (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    const { to, reason } = payload;

    // Authorize caller, recipient, room membership, and active transfer session
    const auth = authorizeP2PTransferPeer(socket, to);
    if (!auth.authorized) {
      console.warn(`[syncHandler] Unauthorized p2p:cancel rejected from ${socket.id} to ${to}: ${auth.reason}`);
      return;
    }

    activeP2PTransfers.delete(auth.transferKey);

    const safeReason = typeof reason === "string" ? reason.slice(0, 200) : "Transfer cancelled";

    io.to(auth.targetSocketId).emit("p2p:cancel", {
      from: socket.id,
      reason: safeReason,
    });
  });

  // Provide ephemeral TURN/ICE credentials if configured on server (RFC 5766 HMAC-SHA1)
  socket.on("p2p:get-ice-servers", (callback) => {
    if (typeof callback !== "function") return;

    const turnSecret = process.env.TURN_SECRET;
    const turnUrls = process.env.TURN_URLS; // e.g. "turn:turn.example.com:3478?transport=udp"

    if (turnSecret && turnUrls) {
      const ttlSec = 86400; // 24 hours
      const timestamp = Math.floor(Date.now() / 1000) + ttlSec;
      const username = `${timestamp}:${socket.id}`;
      const hmac = crypto.createHmac("sha1", turnSecret);
      hmac.update(username);
      const credential = hmac.digest("base64");

      return callback({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: turnUrls.split(",").map((u) => u.trim()),
            username,
            credential,
          },
        ],
      });
    }

    // Default to STUN if TURN server is not configured in environment
    callback({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
  });

  // Helper to evict member, announce departure, and broadcast updated room state
  const handleUserDeparture = (roomId, socketId, username) => {
    // Terminate and notify any active P2P transfers involving the departing socket
    for (const [key, session] of activeP2PTransfers.entries()) {
      if (session.roomId === roomId && (session.requester === socketId || session.target === socketId)) {
        const otherPeer = session.requester === socketId ? session.target : session.requester;
        io.to(otherPeer).emit("p2p:cancel", {
          from: socketId,
          reason: "Peer left the room",
        });
        activeP2PTransfers.delete(key);
      }
    }

    io.to(roomId).emit("file:offer_cancelled", { senderSocketId: socketId });

    const result = removeMemberFromRoom(roomId, socketId);
    if (!result || result.roomDeleted) {
      // Purge any remaining transfer sessions for this room if room was deleted
      for (const [key, session] of activeP2PTransfers.entries()) {
        if (session.roomId === roomId) {
          activeP2PTransfers.delete(key);
        }
      }
      return;
    }

    const room = getRoom(roomId);
    if (room) {
      io.to(roomId).emit("room:user_left", {
        socketId,
        username,
        totalUsers: room.members.size,
        members: serializeRoom(room).members,
      });

      io.to(roomId).emit("chat:message", {
        id: `sys-leave-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        type: "system",
        systemType: "user_left",
        username,
        text: `${username} left the room`,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });

      // Broadcast updated room state in case host migration occurred
      io.to(roomId).emit("room:state", serializeRoom(room));
    }
  };

  // Handle explicit intentional leave (e.g. user clicked "Leave Room") - Instant 0s departure
  socket.on("room:leave", () => {
    const roomId = socket.data.roomId;
    const socketId = socket.id;
    const username = socket.data.username;
    const sessionId = socket.data.sessionId;

    if (!roomId || !username) return;

    const disconnectKey = sessionId ? `${roomId}:${sessionId}` : `${roomId}:${username}`;

    // Cancel any pending disconnect timer
    if (pendingDisconnects.has(disconnectKey)) {
      clearTimeout(pendingDisconnects.get(disconnectKey).timer);
      pendingDisconnects.delete(disconnectKey);
    }

    // Detach socket from room metadata and room channel
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.username = null;
    socket.data.sessionId = null;

    // Immediately evict and notify peers without delay
    handleUserDeparture(roomId, socketId, username);
  });

  // Handle socket disconnect cleanup with 5-second grace period for refreshes/drops
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const socketId = socket.id;
    const username = socket.data.username;
    const sessionId = socket.data.sessionId;

    if (!roomId || !username) return;

    const disconnectKey = sessionId ? `${roomId}:${sessionId}` : `${roomId}:${username}`;

    // Clear any previous timer for this user/session if one existed
    if (pendingDisconnects.has(disconnectKey)) {
      clearTimeout(pendingDisconnects.get(disconnectKey).timer);
    }

    const timer = setTimeout(() => {
      pendingDisconnects.delete(disconnectKey);
      handleUserDeparture(roomId, socketId, username);
    }, RECONNECT_GRACE_PERIOD_MS);

    pendingDisconnects.set(disconnectKey, {
      timer,
      socketId,
      roomId,
      username,
      sessionId,
    });
  });
}
