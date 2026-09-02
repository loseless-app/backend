import express from "express";
import cors from "cors";

// Create and configure Express application
export function createApp() {
  const app = express();

  // Configure CORS middleware
  const corsOrigin = process.env.CORS_ORIGIN || "*";
  app.use(
    cors({
      origin: corsOrigin === "*" ? "*" : corsOrigin.split(","),
      credentials: true,
    })
  );

  // Parse incoming JSON payloads
  app.use(express.json());

  // Health check endpoint for uptime and monitoring
  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });

  return app;
}
