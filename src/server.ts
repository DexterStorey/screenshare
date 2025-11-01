import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";

type Role = "broadcaster" | "viewer";

type ConnectionData = {
  role?: Role;
  viewerId?: string;
};

type SignalMessage =
  | { type: "register"; role: Role }
  | { type: "offer"; viewerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; viewerId: string; sdp: RTCSessionDescriptionInit }
  | {
      type: "candidate";
      viewerId: string;
      candidate: RTCIceCandidateInit;
      origin: Role;
    }
  | { type: "stop" };

const PUBLIC_DIR = resolve(join(import.meta.dir, "../public"));
const JS_DIR = resolve(join(PUBLIC_DIR, "js"));

const viewerSockets = new Map<string, ServerWebSocket<ConnectionData>>();
let broadcasterSocket: ServerWebSocket<ConnectionData> | null = null;
const textDecoder = new TextDecoder();

function broadcastViewerCount() {
  const payload = jsonMessage({
    type: "viewer-count",
    count: viewerSockets.size,
  });

  viewerSockets.forEach((ws) => {
    ws.send(payload);
  });

  if (broadcasterSocket && broadcasterSocket.readyState === WebSocket.OPEN) {
    broadcasterSocket.send(payload);
  }
}

async function buildClientBundles() {
  const result = await Bun.build({
    entrypoints: [
      resolve(join(import.meta.dir, "client/broadcaster.ts")),
      resolve(join(import.meta.dir, "client/viewer.ts")),
    ],
    outdir: JS_DIR,
    minify: true,
    target: "browser",
    splitting: false,
    sourcemap: "linked",
  });

  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    console.error("Failed to build client scripts:\n", details);
    process.exit(1);
  }
}

function promoteToWebSocket(
  req: Request,
  server: Server<ConnectionData>,
): Response | undefined {
  if (server.upgrade(req, { data: {} })) {
    return;
  }

  return new Response("Upgrade failed", { status: 500 });
}

function decodeMessage(raw: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return textDecoder.decode(raw);
  }

  return textDecoder.decode(
    new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
  );
}

function jsonMessage(data: unknown): string {
  return JSON.stringify(data);
}

function ensureBroadcaster(
  ws: ServerWebSocket<ConnectionData>,
): asserts ws is ServerWebSocket<ConnectionData & { role: "broadcaster" }> {
  if (ws.data.role !== "broadcaster") {
    throw new Error("Only the broadcaster may perform this action");
  }
}

function ensureViewer(
  ws: ServerWebSocket<ConnectionData>,
): asserts ws is ServerWebSocket<ConnectionData & { role: "viewer"; viewerId: string }> {
  if (ws.data.role !== "viewer" || !ws.data.viewerId) {
    throw new Error("Only a registered viewer may perform this action");
  }
}

async function serveFile(pathname: string): Promise<Response> {
  const filePath = resolve(join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(file);
}

async function main() {
  await buildClientBundles();

  console.log("Client bundles ready. Starting server on http://localhost:3000");

  Bun.serve<ConnectionData>({
    port: 3000,
    development: process.env.NODE_ENV !== "production",
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const response = promoteToWebSocket(req, server);
        return response ?? new Response(null, { status: 101 });
      }

      switch (url.pathname) {
        case "/":
          return serveFile("index.html");
        case "/viewer":
          return serveFile("viewer.html");
        default: {
          const sanitized = url.pathname.replace(/^\/+/, "");
          return serveFile(sanitized);
        }
      }
    },
    websocket: {
      open(ws) {
        ws.data = {};
      },
      message(ws, rawMessage) {
        try {
          const text = decodeMessage(rawMessage as string | ArrayBuffer | ArrayBufferView);
          const message = JSON.parse(text) as SignalMessage;

          switch (message.type) {
            case "register":
              handleRegister(ws, message.role);
              break;
            case "offer":
              ensureBroadcaster(ws);
              forwardOffer(message.viewerId, message.sdp);
              break;
            case "answer":
              ensureViewer(ws);
              forwardAnswer(message.viewerId, message.sdp);
              break;
            case "candidate":
              if (message.origin === "broadcaster") {
                ensureBroadcaster(ws);
                forwardCandidateToViewer(message.viewerId, message.candidate);
              } else {
                ensureViewer(ws);
                forwardCandidateToBroadcaster(message.viewerId, message.candidate);
              }
              break;
            case "stop":
              ensureBroadcaster(ws);
              stopBroadcast();
              break;
            default:
              console.warn("Unknown message", message);
          }
        } catch (error) {
          console.error("Failed to process message", error);
          ws.send(jsonMessage({ type: "error", message: (error as Error).message }));
        }
      },
      close(ws) {
        if (ws.data.role === "broadcaster") {
          broadcasterSocket = null;
          viewerSockets.forEach((viewerWs) => {
            viewerWs.send(jsonMessage({ type: "broadcaster-ended" }));
            viewerWs.close();
          });
          viewerSockets.clear();
          broadcastViewerCount();
        } else if (ws.data.role === "viewer" && ws.data.viewerId) {
          const { viewerId } = ws.data;
          viewerSockets.delete(viewerId);
          if (broadcasterSocket) {
            broadcasterSocket.send(jsonMessage({
              type: "viewer-left",
              viewerId,
            }));
          }
          broadcastViewerCount();
        }
      },
    },
  });
}

function handleRegister(
  ws: ServerWebSocket<ConnectionData>,
  role: Role,
) {
  if (role === "broadcaster") {
    if (broadcasterSocket && broadcasterSocket.readyState === WebSocket.OPEN) {
      broadcasterSocket.send(jsonMessage({
        type: "error",
        message: "Another broadcaster took over the session.",
      }));
      broadcasterSocket.close();
    }

    ws.data.role = "broadcaster";
    broadcasterSocket = ws;
    ws.send(jsonMessage({ type: "registered", role: "broadcaster" }));

    viewerSockets.forEach((_viewerWs, viewerId) => {
      ws.send(jsonMessage({ type: "viewer-joined", viewerId }));
    });
    console.log("Broadcaster connected");
  } else {
    const viewerId = crypto.randomUUID();
    ws.data.role = "viewer";
    ws.data.viewerId = viewerId;
    viewerSockets.set(viewerId, ws);

    ws.send(jsonMessage({
      type: "registered",
      role: "viewer",
      viewerId,
      hasBroadcaster: Boolean(broadcasterSocket),
    }));

    if (broadcasterSocket) {
      broadcasterSocket.send(jsonMessage({
        type: "viewer-joined",
        viewerId,
      }));
    }

    console.log(`Viewer connected (${viewerId})`);
    broadcastViewerCount();
  }
}

function forwardOffer(viewerId: string, sdp: RTCSessionDescriptionInit) {
  const viewerWs = viewerSockets.get(viewerId);

  if (!viewerWs) {
    broadcasterSocket?.send(
      jsonMessage({
        type: "viewer-missing",
        viewerId,
      }),
    );
    return;
  }

  viewerWs.send(
    jsonMessage({
      type: "offer",
      viewerId,
      sdp,
    }),
  );
}

function forwardAnswer(viewerId: string, sdp: RTCSessionDescriptionInit) {
  if (!broadcasterSocket) {
    return;
  }

  broadcasterSocket.send(
    jsonMessage({
      type: "answer",
      viewerId,
      sdp,
    }),
  );
}

function forwardCandidateToViewer(
  viewerId: string,
  candidate: RTCIceCandidateInit,
) {
  const viewerWs = viewerSockets.get(viewerId);

  viewerWs?.send(
    jsonMessage({
      type: "candidate",
      viewerId,
      candidate,
      origin: "broadcaster",
    }),
  );
}

function forwardCandidateToBroadcaster(
  viewerId: string,
  candidate: RTCIceCandidateInit,
) {
  broadcasterSocket?.send(
    jsonMessage({
      type: "candidate",
      viewerId,
      candidate,
      origin: "viewer",
    }),
  );
}

function stopBroadcast() {
  if (!broadcasterSocket) {
    return;
  }

  viewerSockets.forEach((viewerWs) => {
    viewerWs.send(jsonMessage({ type: "broadcaster-ended" }));
    viewerWs.close();
  });
  viewerSockets.clear();
  broadcasterSocket.send(jsonMessage({ type: "stopped" }));
  broadcastViewerCount();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

