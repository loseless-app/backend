// In-memory room store: sub-millisecond RAM lookups for real-time video sync
const rooms = new Map();

// Creates initial RoomState structure for new rooms
function createRoomState(roomId, mediaType = "url", mediaUrl = "", mediaMetadata = null) {
  return {
    roomId,
    mediaType,
    mediaUrl,
    mediaProvider: "direct", // "youtube" | "twitch" | "direct"
    mediaId: null,
    embedUrl: mediaUrl,
    mediaMetadata,
    mediaOwnerSocketId: null,
    mediaOwnerUsername: null,
    isPlaying: false,
    anchorTime: 0,
    lastStartedAt: 0,
    isBuffering: false,
    bufferingUser: null,
    members: new Map(), // Key = socketId, Value = { socketId, username, isHost }
  };
}

// Retrieves room from RAM or creates a new one
export function getOrCreateRoom(roomId, mediaType = "url", mediaUrl = "", mediaMetadata = null) {
  if (!rooms.has(roomId)) {
    const newRoom = createRoomState(roomId, mediaType, mediaUrl, mediaMetadata);
    rooms.set(roomId, newRoom);
  }
  return rooms.get(roomId);
}

// Fetches an active room by ID (returns null if not found)
export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

// Mutates playback state variables (anchorTime, isPlaying, lastStartedAt, etc.)
export function updateRoomState(roomId, stateUpdates) {
  const room = getRoom(roomId);
  if (!room) return null;

  Object.assign(room, stateUpdates);
  return room;
}

// Resolves duplicate usernames within a room by appending (2), (3), etc.
// Excludes the caller's own socketId and sessionId to prevent self-collision
export function disambiguateUsername(
  roomId,
  requestedUsername,
  incomingSessionId = null,
  incomingSocketId = null,
  pendingDisconnects = null
) {
  const room = getRoom(roomId);
  const cleanBase = (requestedUsername || "Guest").trim() || "Guest";

  // Gather all taken usernames (active members + pending disconnects in this room, excluding self)
  const takenLower = new Set();

  if (room && room.members) {
    for (const member of room.members.values()) {
      if (!member?.username) continue;
      // Skip self: if this member is the same socket or same sessionId, it's not a collision
      if (
        (incomingSocketId && member.socketId === incomingSocketId) ||
        (incomingSessionId && member.sessionId === incomingSessionId)
      ) {
        continue;
      }
      takenLower.add(member.username.trim().toLowerCase());
    }
  }

  if (pendingDisconnects) {
    for (const pending of pendingDisconnects.values()) {
      if (pending?.roomId !== roomId || !pending?.username) continue;
      // Skip self if pending is for the same sessionId or socketId
      if (
        (incomingSessionId && pending.sessionId === incomingSessionId) ||
        (incomingSocketId && pending.socketId === incomingSocketId)
      ) {
        continue;
      }
      takenLower.add(pending.username.trim().toLowerCase());
    }
  }

  // If requested name is not taken, use it directly
  if (!takenLower.has(cleanBase.toLowerCase())) {
    return cleanBase;
  }

  // Extract root base without trailing " (N)" to avoid "Name (2) (2)" chaining
  const baseMatch = cleanBase.match(/^(.*?)(?:\s*\(\d+\))?$/);
  const rootBase = (baseMatch && baseMatch[1] && baseMatch[1].trim()) ? baseMatch[1].trim() : cleanBase;

  // Otherwise, find the next available suffix: "Name (2)", "Name (3)", ...
  let counter = 2;
  while (takenLower.has(`${rootBase.toLowerCase()} (${counter})`)) {
    counter++;
  }

  return `${rootBase} (${counter})`;
}

// Adds user socket to room (first user to join becomes Host)
export function addMemberToRoom(roomId, socketId, username, sessionId = null) {
  const room = getOrCreateRoom(roomId);
  const isFirstMember = room.members.size === 0;

  const member = {
    socketId,
    username,
    sessionId,
    isHost: isFirstMember,
  };

  room.members.set(socketId, member);
  return { room, member };
}

// Re-associates a reconnecting member with a new socketId while preserving host status
export function reconnectMember(roomId, oldSocketId, newSocketId, newSessionId = null) {
  const room = getRoom(roomId);
  if (!room) return null;

  const member = room.members.get(oldSocketId);
  if (!member) return null;

  room.members.delete(oldSocketId);
  member.socketId = newSocketId;
  if (newSessionId) {
    member.sessionId = newSessionId;
  }
  room.members.set(newSocketId, member);

  if (room.mediaOwnerSocketId === oldSocketId) {
    room.mediaOwnerSocketId = newSocketId;
    if (room.mediaMetadata) {
      room.mediaMetadata.ownerSocketId = newSocketId;
    }
  }

  return { room, member };
}

// Removes member socket on disconnect/leave
// Handles host migration & purges room from RAM if empty
export function removeMemberFromRoom(roomId, socketId) {
  const room = getRoom(roomId);
  if (!room) return null;

  const leavingMember = room.members.get(socketId);
  if (!leavingMember) return null;

  room.members.delete(socketId);

  // Purge empty room from RAM to prevent memory leaks
  if (room.members.size === 0) {
    rooms.delete(roomId);
    return { roomDeleted: true };
  }

  // Clear mediaOwnerSocketId if the file owner left
  if (room.mediaOwnerSocketId === socketId) {
    room.mediaOwnerSocketId = null;
    if (room.mediaMetadata) {
      room.mediaMetadata.ownerSocketId = null;
    }
  }

  // Delegate host status to next active member if host left
  if (leavingMember && leavingMember.isHost) {
    const nextMemberKey = room.members.keys().next().value;
    if (nextMemberKey) {
      const nextMember = room.members.get(nextMemberKey);
      nextMember.isHost = true;
    }
  }

  return { roomDeleted: false, remainingMembersCount: room.members.size };
}

// Serializes RoomState for WebSocket JSON transmission (converts members Map to Array, omits private sessionId)
export function serializeRoom(room) {
  if (!room) return null;

  return {
    roomId: room.roomId,
    mediaType: room.mediaType,
    mediaUrl: room.mediaUrl,
    mediaProvider: room.mediaProvider,
    mediaId: room.mediaId,
    embedUrl: room.embedUrl,
    mediaMetadata: room.mediaMetadata || null,
    mediaOwnerSocketId: room.mediaOwnerSocketId || null,
    mediaOwnerUsername: room.mediaOwnerUsername || null,
    isPlaying: room.isPlaying,
    anchorTime: room.anchorTime,
    lastStartedAt: room.lastStartedAt,
    isBuffering: room.isBuffering,
    bufferingUser: room.bufferingUser,
    members: Array.from(room.members.values()).map(({ socketId, username, isHost }) => ({
      socketId,
      username,
      isHost,
    })),
  };
}
