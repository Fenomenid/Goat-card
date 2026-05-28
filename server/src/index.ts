import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { GameError, GameManager, type Room } from "./game.js";

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? (process.env.NODE_ENV === "production" ? "*" : true);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, "../../dist");

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDistPath));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDistPath, "index.html")));
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CLIENT_ORIGIN } });
const games = new GameManager();
const trickTimers = new Map<string, NodeJS.Timeout>();

io.on("connection", (socket) => {
  socket.on("room:create", ({ playerName }: { playerName: string }) => handle(socket.id, () => {
    const room = games.createRoom(socket.id, playerName);
    socket.join(room.id);
    emitRoom(room);
  }));

  socket.on("room:join", ({ roomId, playerName }: { roomId: string; playerName: string }) => handle(socket.id, () => {
    const room = games.joinRoom(socket.id, roomId, playerName);
    socket.join(room.id);
    emitRoom(room);
  }));

  socket.on("game:start", ({ roomId }: { roomId: string }) => handle(socket.id, () => emitRoom(games.startGame(roomId, socket.id))));
  socket.on("round:next", ({ roomId }: { roomId: string }) => handle(socket.id, () => emitRoom(games.nextRound(roomId, socket.id))));
  socket.on("cards:lead", ({ roomId, cardIds }: { roomId: string; cardIds: string[] }) => handle(socket.id, () => emitRoom(games.lead(roomId, socket.id, cardIds))));
  socket.on("cards:beat", ({ roomId, cardIds }: { roomId: string; cardIds: string[] }) => handle(socket.id, () => emitAndMaybeCollect(games.beat(roomId, socket.id, cardIds))));
  socket.on("cards:discard", ({ roomId, cardIds }: { roomId: string; cardIds: string[] }) => handle(socket.id, () => emitAndMaybeCollect(games.discard(roomId, socket.id, cardIds))));

  socket.on("disconnect", () => {
    const room = games.leave(socket.id);
    if (room) {
      const existing = trickTimers.get(room.id);
      if (existing) {
        clearTimeout(existing);
        trickTimers.delete(room.id);
      }
      emitRoom(room);
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

function handle(socketId: string, callback: () => void) {
  try {
    callback();
  } catch (error) {
    const message = error instanceof GameError ? error.message : "Ошибка сервера";
    io.to(socketId).emit("error", { message });
  }
}

function emitAndMaybeCollect(room: Room) {
  emitRoom(room);
  if (room.phase !== "trick_result") return;
  const existing = trickTimers.get(room.id);
  if (existing) clearTimeout(existing);
  trickTimers.set(room.id, setTimeout(() => {
    try {
      const nextRoom = games.collectPendingTrick(room.id);
      trickTimers.delete(room.id);
      emitRoom(nextRoom);
    } catch {
      trickTimers.delete(room.id);
    }
  }, 1800));
}
function emitRoom(room: Room) {
  for (const player of room.players) {
    io.to(player.id).emit("room", games.snapshot(room, player.id, publicOrigin()));
  }
}

function publicOrigin() {
  if (process.env.PUBLIC_CLIENT_ORIGIN) return process.env.PUBLIC_CLIENT_ORIGIN;
  if (process.env.NODE_ENV === "production") return undefined;
  return "http://localhost:5173";
}
