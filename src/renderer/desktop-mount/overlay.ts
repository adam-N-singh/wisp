// Capture overlay: a full-screen transparent window over the primary display.
// Drag selects a region; a click without dragging captures the whole screen.
import type { EdgeClient } from "../../shared/rpc/edge";
import type { captureOverlayEdge } from "../../shared/edges";
import "./overlay.css";

declare global {
  interface Window {
    desktopMountCaptureOverlay: EdgeClient<typeof captureOverlayEdge>;
  }
}

const overlay = window.desktopMountCaptureOverlay;
const selection = document.getElementById("selection")!;
let origin: { x: number; y: number } | null = null;
let done = false;

const rect = (event: PointerEvent) => {
  const x = Math.min(origin!.x, event.clientX);
  const y = Math.min(origin!.y, event.clientY);
  return { x, y, width: Math.abs(event.clientX - origin!.x), height: Math.abs(event.clientY - origin!.y) };
};

window.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || done) return;
  origin = { x: event.clientX, y: event.clientY };
  document.body.classList.add("selecting");
});

window.addEventListener("pointermove", (event) => {
  if (origin == null) return;
  const { x, y, width, height } = rect(event);
  selection.hidden = width < 3 && height < 3;
  Object.assign(selection.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
});

window.addEventListener("pointerup", (event) => {
  if (origin == null || done) return;
  const region = rect(event);
  origin = null;
  done = true;
  if (region.width < 6 || region.height < 6) void overlay.pickScreen();
  else void overlay.chooseRegion(region);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !done) {
    done = true;
    void overlay.cancel();
  }
});
