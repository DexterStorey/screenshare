export {};

const SIGNAL_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector) as T | null;
  if (!element) {
    throw new Error(`Viewer UI failed to initialise (${selector})`);
  }
  return element;
}

type ServerMessage =
  | {
      type: "registered";
      role: "viewer";
      viewerId: string;
      hasBroadcaster: boolean;
    }
  | { type: "offer"; viewerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "candidate"; viewerId: string; candidate: RTCIceCandidateInit; origin: "broadcaster" | "viewer" }
  | { type: "broadcaster-ended" }
  | { type: "viewer-count"; count: number }
  | { type: "error"; message: string };

const videoElement = requireElement<HTMLVideoElement>("#stream");
const statusLabel = requireElement<HTMLParagraphElement>("#status");
const liveIndicator = requireElement<HTMLSpanElement>("#live-indicator");
const interactionOverlay = requireElement<HTMLDivElement>("#interaction-overlay");
const resumeButton = requireElement<HTMLButtonElement>("#resume");
const waitingIndicator = requireElement<HTMLDivElement>("#waiting-indicator");
const viewerCountLabel = requireElement<HTMLSpanElement>("#viewer-count");

let socket: WebSocket | null = null;
let viewerId: string | null = null;
let peerConnection: RTCPeerConnection | null = null;

function setStatus(message: string) {
  statusLabel.textContent = message;
}

function setLive(isLive: boolean) {
  liveIndicator.toggleAttribute("hidden", !isLive);
}

function setWaiting(waiting: boolean) {
  waitingIndicator.classList.toggle("hidden", !waiting);
}

function showOverlay() {
  interactionOverlay.classList.remove("hidden");
}

function hideOverlay() {
  interactionOverlay.classList.add("hidden");
}

function updateViewerCount(count: number) {
  if (count <= 0) {
    viewerCountLabel.textContent = "No one watching yet";
    viewerCountLabel.toggleAttribute("hidden", true);
    return;
  }

  viewerCountLabel.textContent = count === 1 ? "1 person watching" : `${count} people watching`;
  viewerCountLabel.toggleAttribute("hidden", false);
}

async function attemptPlayback(options: { userGesture?: boolean } = {}) {
  if (!videoElement.srcObject) {
    return false;
  }

  try {
    await videoElement.play();
    hideOverlay();
    return true;
  } catch (error) {
    if (!options.userGesture) {
      showOverlay();
    }
    console.warn("Autoplay prevented, waiting for user interaction", error);
    return false;
  }
}

function connectSocket() {
  socket = new WebSocket(SIGNAL_URL);

  socket.addEventListener("open", () => {
    socket?.send(JSON.stringify({ type: "register", role: "viewer" }));
    setStatus("Connected. Waiting for broadcaster...");
    setWaiting(true);
  });

  socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data) as ServerMessage;
    await handleServerMessage(data);
  });

  socket.addEventListener("close", () => {
    setStatus("Connection closed.");
    cleanupPeer();
  });

  socket.addEventListener("error", () => {
    setStatus("Signalling error");
  });
}

async function handleServerMessage(message: ServerMessage) {
  switch (message.type) {
    case "registered":
      viewerId = message.viewerId;
      if (message.hasBroadcaster) {
        setStatus("Broadcaster available. Preparing stream...");
        setWaiting(false);
      } else {
        setStatus("Waiting for broadcaster to start streaming...");
        setWaiting(true);
      }
      break;
    case "offer":
      if (!viewerId || message.viewerId !== viewerId) {
        return;
      }

      setWaiting(false);
      setStatus("Connecting to live stream...");
      await ensurePeerConnection();

      await peerConnection!.setRemoteDescription(message.sdp);
      const answer = await peerConnection!.createAnswer();
      await peerConnection!.setLocalDescription(answer);

      socket?.send(
        JSON.stringify({
          type: "answer",
          viewerId,
          sdp: answer,
        }),
      );

      setStatus("Receiving stream...");
      void attemptPlayback();
      break;
    case "candidate":
      if (message.origin === "broadcaster" && peerConnection && message.candidate) {
        await peerConnection.addIceCandidate(message.candidate);
      }
      break;
    case "broadcaster-ended":
      setStatus("Broadcast ended. Waiting for it to restart...");
      cleanupPeer();
      setWaiting(true);
      hideOverlay();
      break;
    case "viewer-count":
      updateViewerCount(message.count);
      break;
    case "error":
      setStatus(`Error: ${message.message}`);
      break;
  }
}

async function ensurePeerConnection() {
  if (peerConnection) {
    return;
  }

  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  peerConnection.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      videoElement.srcObject = stream;
      videoElement.muted = false;
      setLive(true);
      setWaiting(false);
      void attemptPlayback();
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (!viewerId || !event.candidate || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "candidate",
        viewerId,
        candidate: event.candidate,
        origin: "viewer",
      }),
    );
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) {
      return;
    }

    if (
      peerConnection.connectionState === "disconnected" ||
      peerConnection.connectionState === "failed" ||
      peerConnection.connectionState === "closed"
    ) {
      cleanupPeer();
      setStatus("Connection to broadcaster lost.");
      setWaiting(true);
    }
  };
}

function cleanupPeer() {
  peerConnection?.close();
  peerConnection = null;
  videoElement.srcObject = null;
  setLive(false);
  hideOverlay();
}

window.addEventListener("beforeunload", () => {
  cleanupPeer();
  socket?.close();
});

resumeButton.addEventListener("click", async () => {
  hideOverlay();
  await attemptPlayback({ userGesture: true });
});

connectSocket();

