// Small stroke icon set (16px grid).
import type { SVGProps } from "react";

const paths = {
  plus: "M8 3v10M3 8h10",
  search: "M7 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11ZM11 11l3.5 3.5",
  gear: "M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64 3.58 3.58",
  send: "M8 13.5v-11M4 6.5l4-4 4 4",
  stop: "M4.5 4.5h7v7h-7z",
  paperclip: "M13 7.5 8 12.5a3.18 3.18 0 0 1-4.5-4.5l5.25-5.25a2.12 2.12 0 0 1 3 3L6.5 11a1.06 1.06 0 0 1-1.5-1.5l4.75-4.75",
  close: "M4 4l8 8M12 4l-8 8",
  chevronDown: "M4 6l4 4 4-4",
  chevronUp: "M4 10l4-4 4 4",
  chevronRight: "M6 4l4 4-4 4",
  chevronLeft: "M10 4l-4 4 4 4",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  sidebar: "M2.5 3.5h11v9h-11zM6 3.5v9",
  panelRight: "M2.5 3.5h11v9h-11zM10 3.5v9",
  pin: "M9.5 2.5l4 4-2 1-2.5 2.5.5 3-1 1-3-3-3.5 3.5M5.5 7.5 8.5 4.5",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9",
  edit: "M10.5 2.5l3 3-8 8H2.5v-3z",
  monitor: "M2 3h12v8H2zM6 14h4M8 11v3",
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 5v3l2 1.5",
  check: "M3.5 8.5l3 3 6-7",
  alert: "M8 2.5 14 13H2zM8 6.5v3M8 11.5h.01",
  folder: "M2 4.5h4l1.5 1.5H14v7H2z",
  refresh: "M13 8A5 5 0 1 1 11.5 4.5M13 2.5v3h-3",
  terminal: "M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10.5h2.5",
  file: "M4 1.5h5l3 3V14.5H4zM9 1.5v3h3",
  globe: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14c-1.7-1.8-2.5-3.8-2.5-6S6.3 3.8 8 2Z",
  sparkle: "M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  play: "M5.5 3v10l7-5z",
  brain: "M6 13.5V3.5a2 2 0 0 0-3.5 1.3A2.2 2.2 0 0 0 2 8.5a2.2 2.2 0 0 0 1.5 3.3A2 2 0 0 0 6 13.5ZM10 13.5V3.5a2 2 0 0 1 3.5 1.3A2.2 2.2 0 0 1 14 8.5a2.2 2.2 0 0 1-1.5 3.3A2 2 0 0 1 10 13.5Z",
  shield: "M8 1.75 13 3.5V8c0 3-2.2 5.2-5 6.25C5.2 13.2 3 11 3 8V3.5z",
  mount: "M2 3h12v7.5H2zM5.5 13.5h5M8 10.5v3",
  plug: "M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3",
  info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 7.5v3.5M8 5h.01",
  bolt: "M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z",
  download: "M8 2.5v7.5M4.5 6.5 8 10l3.5-3.5M3 13.5h10",
  bell: "M4 11V7.5a4 4 0 0 1 8 0V11l1.25 1.5H2.75zM6.5 14h3",
  bellOff: "M4.5 4.6A4 4 0 0 0 4 7.5V11l-1.25 1.5h8.75M6 3.9a4 4 0 0 1 6 3.6v2.9M6.5 14h3M2.5 2.5l11 11",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  eyeOff: "M2.5 2.5l11 11M6.6 6.6a2 2 0 0 0 2.8 2.8M4.3 4.8C2.6 5.9 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.5-.5 3.4-1.1M7 3.6l1-.1c4 0 6.5 4.5 6.5 4.5s-.5.9-1.4 1.9",
  keyboard: "M1.5 4h13v8h-13zM4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7",
  message: "M2.5 3h11v8h-6l-3 2.5V11h-2z",
  sun: "M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1",
  moon: "M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z",
  contrast: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 2v12",
  mic:"M8 1.75A2.25 2.25 0 0 0 5.75 4v3.5a2.25 2.25 0 0 0 4.5 0V4A2.25 2.25 0 0 0 8 1.75ZM3.75 7.25a4.25 4.25 0 0 0 8.5 0M8 11.5v2.75M5.75 14.25h4.5",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  speaker: "M2.5 6h2.5l3.5-3v10l-3.5-3H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.75 3.75a6 6 0 0 1 0 8.5",
  waveform: "M2 7v2M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14 7.25v1.5",
  reaction:"M13.94 7.17A6 6 0 1 1 8.8 2.05M5.5 9.5s.9 1.5 2.5 1.5 2.5-1.5 2.5-1.5M6 6.5h.01M10 6.5h.01M12.5 1.5v4M10.5 3.5h4",
  reply: "M6.5 4 2.5 8l4 4M2.5 8h7a4 4 0 0 1 4 4v1",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  thumbsUp: "M4.5 7v6.5h-2V7zM4.5 7 7 2.5c1 0 1.7.8 1.5 1.8L8 6.5h4.2a1.3 1.3 0 0 1 1.3 1.5l-.8 4.3a1.5 1.5 0 0 1-1.5 1.2H4.5",
  thumbsDown: "M4.5 9V2.5h-2V9zM4.5 9 7 13.5c1 0 1.7-.8 1.5-1.8L8 9.5h4.2a1.3 1.3 0 0 0 1.3-1.5l-.8-4.3a1.5 1.5 0 0 0-1.5-1.2H4.5",
  arrowDown: "M8 3v10M3.5 8.5 8 13l4.5-4.5",
  code: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5",
  expand: "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9",
  chart: "M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5",
  outline: "M2.5 3.5h11M5.5 6.5h8M5.5 9.5h8M2.5 12.5h11",
  wrench: "M13.5 4.5a3 3 0 0 1-4.1 2.8L4 12.7a1.1 1.1 0 0 1-1.6-1.6l5.4-5.4A3 3 0 0 1 11.5 2.5L9.7 4.3l.3 1.7 1.7.3z",
  xCircle: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM6 6l4 4M10 6l-4 4",
  share: "M8 10V2.5M4.75 5.5 8 2.5l3.25 3M3 8.5v5h10v-5",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={paths[name]} />
    </svg>
  );
}
