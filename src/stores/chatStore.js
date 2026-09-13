// MongoDB chat store: persists room chat messages for history & moderation
import { MongoClient } from "mongodb";

const CHAT_COLLECTION = "chat_messages";

let messagesCollection = null;
let connectPromise = null;

// Lazy singleton connection; safe to call from concurrent handlers.
// Retries on failure so a down Mongo doesn't permanently kill chat.
// env vars are read here (not at module scope) so dotenv.config() in
// index.js has already run by the time a connection is attempted.
async function ensureCollection() {
  if (messagesCollection) return messagesCollection;

  if (!connectPromise) {
    connectPromise = (async () => {
      const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
      const mongoDb = process.env.MONGODB_DB || "watchparty";

      const client = new MongoClient(mongoUri);
      await client.connect();
      messagesCollection = client.db(mongoDb).collection(CHAT_COLLECTION);
      // Index for fast per-room history queries (latest first)
      await messagesCollection.createIndex({ roomId: 1, createdAt: -1 });
      console.log(`[MongoDB] Chat store connected (db: ${mongoDb})`);
    })().catch((err) => {
      connectPromise = null; // allow retry on next call
      throw err;
    });
  }

  await connectPromise;
  return messagesCollection;
}

// Maps a stored document to the wire shape used by Socket.io
function toMessageObj(doc) {
  return {
    id: doc._id.toString(),
    username: doc.username,
    text: doc.text,
    createdAt: doc.createdAt,
  };
}

// Persists a chat message to the room's history.
// Returns the saved message in wire shape, or null on DB failure.
export async function saveMessage(roomId, username, text) {
  try {
    const collection = await ensureCollection();
    const doc = {
      roomId,
      username,
      text,
      createdAt: new Date(),
    };
    const { insertedId } = await collection.insertOne(doc);
    return { id: insertedId.toString(), ...doc };
  } catch (err) {
    console.error("[MongoDB] Failed to save chat message:", err.message);
    return null;
  }
}

// Fetches the most recent messages for a room, oldest-first for display.
export async function getRecentMessages(roomId, limit = 50) {
  try {
    const collection = await ensureCollection();
    const docs = await collection
      .find({ roomId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse().map(toMessageObj);
  } catch (err) {
    console.error("[MongoDB] Failed to fetch chat history:", err.message);
    return [];
  }
}