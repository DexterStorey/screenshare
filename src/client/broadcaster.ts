export {};

const SIGNAL_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

type ServerMessage =
  | { type: "registered"; role: "broadcaster" }
  | { type: "viewer-joined"; viewerId: string }
  | { type: "answer"; viewerId: string; sdp: RTCSessionDescriptionInit }
  | {
      type: "candidate";
      viewerId: string;
      candidate: RTCIceCandidateInit;
      origin: "viewer" | "broadcaster";
    }
  | { type: "viewer-left"; viewerId: string }
  | { type: "viewer-missing"; viewerId: string }
  | { type: "viewer-count"; count: number }
  | { type: "error"; message: string }
  | { type: "stopped" }
  | { type: "broadcaster-ended" };

type PeerEntry = {
  connection: RTCPeerConnection;
};

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector) as T | null;
  if (!element) {
    throw new Error(`Unable to initialise broadcaster UI (${selector})`);
  }
  return element;
}

const startButton = requireElement<HTMLButtonElement>("#start");
const stopButton = requireElement<HTMLButtonElement>("#stop");
const statusLabel = requireElement<HTMLParagraphElement>("#status");
const preview = requireElement<HTMLVideoElement>("#preview");

let socket: WebSocket | null = null;
let mediaStream: MediaStream | null = null;
const peers = new Map<string, PeerEntry>();
const pendingViewers = new Set<string>();

function setStatus(message: string) {
  statusLabel.textContent = message;
}

function enableButtons({ canStart, canStop }: { canStart: boolean; canStop: boolean }) {
  startButton.disabled = !canStart;
  stopButton.disabled = !canStop;
}

function connectSocket() {
  socket = new WebSocket(SIGNAL_URL);

  socket.addEventListener("open", () => {
    socket?.send(JSON.stringify({ type: "register", role: "broadcaster" }));
    setStatus("Connected to signalling server. Ready to share.");
    enableButtons({ canStart: true, canStop: false });
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data) as ServerMessage;
    handleServerMessage(data);
  });

  socket.addEventListener("close", () => {
    setStatus("Signalling connection closed.");
    enableButtons({ canStart: false, canStop: false });
    cleanupPeers();
  });

  socket.addEventListener("error", () => {
    setStatus("Signalling connection error.");
  });
}

async function startBroadcast() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Not connected to signalling server yet.");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser",
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 3840, max: 3840 },
        height: { ideal: 2160, max: 2160 },
        aspectRatio: { ideal: 16 / 9 },
      },
      audio: true,
    });

    const [videoTrack] = mediaStream.getVideoTracks();
    if (videoTrack) {
      videoTrack.contentHint = "motion";
    }

    preview.srcObject = mediaStream;
    preview.muted = true;
    await preview.play();

    setStatus("Sharing in progress. Waiting for viewers...");
    enableButtons({ canStart: false, canStop: true });

    if (pendingViewers.size > 0) {
      pendingViewers.forEach((viewerId) => {
        void handleViewerRequest(viewerId);
      });
    }
  } catch (error) {
    console.error("Failed to acquire display media", error);
    setStatus("Screen capture was blocked or failed.");
  }
}

function stopBroadcast({ notifyServer }: { notifyServer: boolean }) {
  peers.forEach(({ connection }) => connection.close());
  peers.clear();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  preview.srcObject = null;

  if (notifyServer && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stop" }));
  }

  pendingViewers.clear();
  enableButtons({ canStart: true, canStop: false });
  setStatus("Sharing stopped.");
}

function cleanupPeers() {
  peers.forEach(({ connection }) => connection.close());
  peers.clear();
}

function createPeerConnection(viewerId: string): RTCPeerConnection {
  if (!mediaStream) {
    throw new Error("Media stream is not initialised");
  }

  const connection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  mediaStream.getTracks().forEach((track) => {
    const sender = connection.addTrack(track, mediaStream!);

    if (track.kind === "video") {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }

      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate: 18_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      };

      void sender.setParameters(parameters);
    } else if (track.kind === "audio") {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }

      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate: 192_000,
      };

      void sender.setParameters(parameters);
    }
  });

  connection.onicecandidate = (event) => {
    if (event.candidate && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "candidate",
          viewerId,
          candidate: event.candidate,
          origin: "broadcaster",
        }),
      );
    }
  };

  connection.onconnectionstatechange = () => {
    if (
      connection.connectionState === "disconnected" ||
      connection.connectionState === "failed" ||
      connection.connectionState === "closed"
    ) {
      peers.delete(viewerId);
    }
  };

  peers.set(viewerId, { connection });
  return connection;
}

async function handleViewerRequest(viewerId: string) {
  if (!mediaStream) {
    setStatus("Viewer connected but sharing not started yet.");
    pendingViewers.add(viewerId);
    return;
  }

  pendingViewers.delete(viewerId);
  const peer = createPeerConnection(viewerId);

  const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await peer.setLocalDescription(offer);

  socket?.send(
    JSON.stringify({
      type: "offer",
      viewerId,
      sdp: offer,
    }),
  );

  setStatus(`Sharing to ${peers.size} viewer(s).`);
}

async function handleServerMessage(message: ServerMessage) {
  switch (message.type) {
    case "registered":
      enableButtons({ canStart: true, canStop: false });
      break;
    case "viewer-joined":
      await handleViewerRequest(message.viewerId);
      break;
    case "viewer-left":
      peers.get(message.viewerId)?.connection.close();
      peers.delete(message.viewerId);
      pendingViewers.delete(message.viewerId);
      setStatus(`Viewer left. ${peers.size} remaining.`);
      break;
    case "viewer-missing":
      peers.get(message.viewerId)?.connection.close();
      peers.delete(message.viewerId);
      pendingViewers.delete(message.viewerId);
      setStatus("Viewer disconnected before the offer completed.");
      break;
    case "answer": {
      const peer = peers.get(message.viewerId)?.connection;
      if (peer) {
        await peer.setRemoteDescription(message.sdp);
      }
      break;
    }
    case "candidate": {
      const peer = peers.get(message.viewerId)?.connection;
      if (peer && message.candidate) {
        await peer.addIceCandidate(message.candidate);
      }
      break;
    }
    case "viewer-count": {
      if (mediaStream) {
        const viewerText = message.count === 1 ? "1 viewer" : `${message.count} viewers`;
        setStatus(`Sharing to ${viewerText}.`);
      }
      break;
    }
    case "stopped":
      stopBroadcast({ notifyServer: false });
      break;
    case "error":
      setStatus(`Error: ${message.message}`);
      break;
    case "broadcaster-ended":
      setStatus("Broadcast ended.");
      break;
  }
}

startButton.addEventListener("click", () => {
  void startBroadcast();
});

stopButton.addEventListener("click", () => {
  stopBroadcast({ notifyServer: true });
});

window.addEventListener("beforeunload", () => {
  stopBroadcast({ notifyServer: true });
  socket?.close();
});

connectSocket();

