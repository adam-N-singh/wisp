// The main window's preload. The window runs it in every frame (nodeIntegrationInSubFrames), so what
// agents write can't reach the network around its CSP (src/shared/frame-lockdown.ts):
//   - in the app's own page, the top frame, it is preload.ts, which exposes `window.desktop`;
//   - in any other frame (a visualization, a canvas, or a frame either makes) it exposes nothing and
//     sends nothing: it only takes WebRTC out of the frame's own world before the frame's script runs.
// A frame's `javascript:` child is the one world this doesn't reach; the frames' Trusted Types policy
// blocks those (src/shared/visualization.ts).
import { contextBridge } from "electron";
import { removeGlobals, WEBRTC_GLOBALS } from "../shared/frame-lockdown";

if (window.top === window) require("./preload");
else contextBridge.executeInMainWorld({ func: removeGlobals, args: [WEBRTC_GLOBALS] });
