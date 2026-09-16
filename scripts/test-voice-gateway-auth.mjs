import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import { WebSocket } from "ws";

register("./lib/register-alias.mjs", import.meta.url);
const gateway = await import("./voice-gateway.mjs");

const accessServer = createServer((request, response) => {
  if (request.url?.endsWith("/voice/utterance-access") && request.headers.cookie === "session=valid") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, userId: "user-1" }));
    return;
  }
  response.writeHead(401, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "Not logged in" }));
});
await new Promise((resolve) => accessServer.listen(0, "127.0.0.1", resolve));
const accessPort = accessServer.address().port;
process.env.NEXT_BASE_URL = `http://127.0.0.1:${accessPort}`;
delete process.env.VOICE_GATEWAY_ORIGINS;
delete process.env.APP_PUBLIC_URL;

const { httpServer, wss } = gateway.createGatewayServer();
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const port = httpServer.address().port;

async function connect(cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/audio/campaign-1`, {
    headers: { origin: "http://localhost:3005", cookie },
  });
  const messages = [];
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "hello", capture_sample_rate: 16_000 }));
  return { socket, messages, closed };
}

const forged = await connect("session=forged");
await forged.closed;
assert.equal(forged.messages.some((message) => message.type === "ready"), false);
assert.equal(forged.messages.some((message) => message.type === "error"), true);

const authorized = await connect("session=valid");
for (let i = 0; i < 40 && !authorized.messages.some((message) => message.type === "ready"); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(authorized.messages.some((message) => message.type === "connected"), true);
assert.equal(authorized.messages.some((message) => message.type === "ready"), true);
authorized.socket.close();
await new Promise((resolve) => authorized.socket.once("close", resolve));
await new Promise((resolve) => httpServer.close(resolve));
wss.close();
await new Promise((resolve) => accessServer.close(resolve));
console.log("test-voice-gateway-auth: 4 passed");
