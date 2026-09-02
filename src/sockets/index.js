import { Server } from "socket.io";
import { registerSyncHandlers } from "./syncHandler.js";

// Initialize Socket.io server instance and attach event handlers
export function initializeSockets(httpServer, corsOrigin = "*") {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin === "*" ? "*" : corsOrigin.split(","),
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Handle new client connections
  io.on("connection", (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    // Register all watch party sync handlers for this socket connection
    registerSyncHandlers(io, socket);

    socket.on("disconnect", (reason) => {
      console.log(`[Socket Disconnected] ID: ${socket.id} (Reason: ${reason})`);
    });
  });

  return io;
}
