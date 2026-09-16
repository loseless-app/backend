import http from "http";
import dotenv from "dotenv";
import { createApp } from "./src/app.js";
import { initializeSockets } from "./src/sockets/socket.js";

// Load environment variables from .env file
dotenv.config();

const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Initialize Express application
const app = createApp();

// Create native HTTP server wrapping Express
const server = http.createServer(app);

// Attach Socket.io WebSocket router to HTTP server
initializeSockets(server, CORS_ORIGIN);

// Start listening for incoming HTTP & WebSocket traffic
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`Watch Party Sync Server is live`);
  console.log(`Listening on PORT: ${PORT}`);
  console.log(`CORS Allowed Origin: ${CORS_ORIGIN}`);
  console.log(`====================================================`);
});
