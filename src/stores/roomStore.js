// In-memory room store: sub-millisecond RAM lookups for real-time video sync
const rooms = new Map();

// Creates initial RoomState structure for new rooms
function createRoomState(roomId, mediaType = "url", mediaUrl = "") {
  return {
    roomId,
    mediaType,
    mediaUrl,
    isPlaying: false,
    anchorTime: 0,
    lastStartedAt: 0,
    isBuffering: false,
    bufferingUser: null,
    members: new Map(), // Key = socketId, Value = { socketId, username, isHost }
  };
}

// Retrieves room from RAM or creates a new one
export function getOrCreateRoom(roomId, mediaType = "url", mediaUrl = "") {
  if (!rooms.has(roomId)) {
    const newRoom = createRoomState(roomId, mediaType, mediaUrl);
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

// Adds user socket to room (first user to join becomes Host)
export function addMemberToRoom(roomId, socketId, username) {
  const room = getOrCreateRoom(roomId);
  const isFirstMember = room.members.size === 0;

  const member = {
    socketId,
    username,
    isHost: isFirstMember,
  };

  room.members.set(socketId, member);
  return { room, member };
}

// Removes member socket on disconnect/leave
// Handles host migration & purges room from RAM if empty
export function removeMemberFromRoom(roomId, socketId) {
  const room = getRoom(roomId);
  if (!room) return null;

  const leavingMember = room.members.get(socketId);
  room.members.delete(socketId);

  // Purge empty room from RAM to prevent memory leaks
  if (room.members.size === 0) {
    rooms.delete(roomId);
    return { roomDeleted: true };
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

// Serializes RoomState for WebSocket JSON transmission (converts members Map to Array)
export function serializeRoom(room) {
  if (!room) return null;

  return {
    roomId: room.roomId,
    mediaType: room.mediaType,
    mediaUrl: room.mediaUrl,
    isPlaying: room.isPlaying,
    anchorTime: room.anchorTime,
    lastStartedAt: room.lastStartedAt,
    isBuffering: room.isBuffering,
    bufferingUser: room.bufferingUser,
    members: Array.from(room.members.values()),
  };
}
