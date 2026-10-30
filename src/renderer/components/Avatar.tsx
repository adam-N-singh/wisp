// Bot avatars: a colored silhouette with a two-eyed face, in one of 26
// shapes (blob, capsule, hex, …). A group chat's avatar stacks two of its members' (AgentAvatar.tsx
// picks them; this file reads no store, so the desktop-mount pages can use it too).
import type { AgentSummary, AvatarColor, AvatarShape } from "../../shared/model";

const SHAPES: Record<AvatarShape, string> = {
  arch: "M4 28V14a12 12 0 0 1 24 0v14z",
  bean: "M10 4c7-2 15 3 16 11 1 9-6 14-13 13S3 23 4 15c.6-5 2-9.6 6-11z",
  blob: "M16 3c8 0 13 5 13 12s-4 14-13 14S3 24 3 16 8 3 16 3z",
  capsule: "M10 3h12a7 7 0 0 1 7 7v12a7 7 0 0 1-7 7H10a7 7 0 0 1-7-7V10a7 7 0 0 1 7-7z",
  cloud: "M9 26a6 6 0 0 1-1-11.9A8 8 0 0 1 23.5 11 6.5 6.5 0 0 1 24 26z",
  clover: "M16 3a6 6 0 0 1 5.6 8.2A6 6 0 1 1 21 22.5 6 6 0 1 1 11 22.5a6 6 0 1 1-.6-11.3A6 6 0 0 1 16 3z",
  crystal: "M16 2l11 9-11 19L5 11z",
  cylinder: "M5 8c0-3 22-3 22 0v16c0 3-22 3-22 0z",
  dome: "M3 27v-8a13 13 0 0 1 26 0v8z",
  egg: "M16 3c6 0 11 9 11 16a11 11 0 0 1-22 0C5 12 10 3 16 3z",
  flower: "M16 4a4 4 0 0 1 4 4 4 4 0 1 1 4 7 4 4 0 1 1-2 7 4 4 0 1 1-6 3 4 4 0 1 1-6-3 4 4 0 1 1-2-7 4 4 0 1 1 4-7 4 4 0 0 1 4-4z",
  gem: "M9 4h14l6 8-13 17L3 12z",
  heart: "M16 28S3 20 3 11a7 7 0 0 1 13-3.5A7 7 0 0 1 29 11c0 9-13 17-13 17z",
  hex: "M16 2l12 7v14l-12 7-12-7V9z",
  house: "M16 3l13 11v15H3V14z",
  leaf: "M5 27C5 12 13 4 28 4c0 15-8 23-23 23z",
  pebble: "M8 7c6-4 17-3 20 5s-1 16-11 16S1 23 3 15c.7-3.3 2.4-6.3 5-8z",
  pumpkin: "M16 6c3-2 8-2 11 2s3 13-1 17-12 4-10 4-8 0-11-4-2.8-14.2 0-17 6.8-3.4 11-2z",
  shield: "M16 3l12 4v8c0 7-5 12-12 15C9 27 4 22 4 15V7z",
  sparkle: "M16 2c1.5 7 5 11 13 14-8 3-11.5 7-13 14-1.5-7-5-11-13-14 8-3 11.5-7 13-14z",
  square: "M5 5h22v22H5z",
  squircle: "M16 3c11 0 13 2 13 13s-2 13-13 13S3 27 3 16 5 3 16 3z",
  star: "M16 2l4.2 8.6 9.5 1.4-6.9 6.7 1.6 9.4L16 23.6 7.6 28.1l1.6-9.4-6.9-6.7 9.5-1.4z",
  tablet: "M8 2h16a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z",
  teardrop: "M16 2c5 7 11 12 11 18a11 11 0 0 1-22 0c0-6 6-11 11-18z",
  wedge: "M3 27L16 4l13 23z",
};

export const AVATAR_FILL: Record<AvatarColor, string> = {
  blue: "#5b8def",
  green: "#3fb27f",
  orange: "#f08c3a",
  pink: "#ec6fa8",
  purple: "#9a6ff0",
  red: "#e5534b",
  teal: "#2fb3b3",
  yellow: "#e6b422",
  gray: "#8b8f98",
};

/** The silhouette, or `image` (a small picture an agent got from its bot template) in its place. */
export function Avatar({ shape = "blob", color = "gray", size = 28, busy = false, image = null }: { shape?: AvatarShape; color?: AvatarColor; size?: number; busy?: boolean; image?: string | null }) {
  return (
    <span className={`avatar${busy ? " avatar--busy" : ""}`} style={{ width: size, height: size }}>
      {image != null ? (
        <img className="avatar__image" src={image} width={size} height={size} alt="" />
      ) : (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
          <path d={SHAPES[shape] ?? SHAPES.blob} fill={AVATAR_FILL[color] ?? AVATAR_FILL.gray} />
          <rect x="11.2" y="13" width="2.6" height="4.6" rx="1.3" fill="#141414" />
          <rect x="18.2" y="13" width="2.6" height="4.6" rx="1.3" fill="#141414" />
        </svg>
      )}
    </span>
  );
}

type AvatarLook = Pick<AgentSummary, "avatarShape" | "avatarColor" | "avatarDataUrl">;

/** Two members' avatars, the second over the first's corner. */
export function AvatarStack({ members, size = 28, busy = false }: { members: AvatarLook[]; size?: number; busy?: boolean }) {
  const small = Math.round(size * 0.7);
  const [back, front] = members;
  return (
    <span className={`avatar avatar-stack${busy ? " avatar--busy" : ""}`} style={{ width: size, height: size }}>
      <span className="avatar-stack__back">
        <Avatar shape={back?.avatarShape} color={back?.avatarColor} size={small} image={back?.avatarDataUrl ?? null} />
      </span>
      <span className="avatar-stack__front">
        <Avatar shape={front?.avatarShape} color={front?.avatarColor ?? "gray"} size={small} image={front?.avatarDataUrl ?? null} />
      </span>
    </span>
  );
}
