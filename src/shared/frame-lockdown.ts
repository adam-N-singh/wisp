// What the main window's preload (src/preload/main-window.ts) takes out of every frame but the app's
// own page: the frames agents' visualizations and canvases run in, and any frame those make. Their
// CSP loads and connects nothing, but no CSP directive covers WebRTC in Chromium: a peer connection
// would look up and reach the STUN and TURN servers the page names, carrying whatever it put in the
// names. The preload runs this in the frame's own world before the frame's script does.

/** WebRTC's constructors. Nothing else reaches the network without one of them. */
export const WEBRTC_GLOBALS: readonly string[] = ["RTCPeerConnection", "webkitRTCPeerConnection"];

/**
 * Takes these globals out of the world it runs in for good: each becomes undefined, read-only and
 * non-configurable, so the page can't put it back. Self-contained, as
 * `contextBridge.executeInMainWorld` runs a copy of its source in the frame's world.
 */
export function removeGlobals(names: readonly string[], target: object = globalThis): void {
  for (const name of names) {
    try {
      Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false, enumerable: false });
    } catch {
      // already taken out
    }
  }
}
