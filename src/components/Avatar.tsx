// Bot avatar — cute mascot styles, wrapped in the historical MausAvatar
// API so call sites keep compiling. Motion is blink + soft idle eyes only;
// expression / pointer props are still accepted and ignored.
import {
  forwardRef,
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { mascotLayerMarkup, mascotSvgMarkup, scopeMascotSvgIds } from "@/lib/mascot-art";
import {
  botAvatarAssetPath,
  botAvatarProfile,
  isBotAvatarId,
  mascotStyleSchema,
  resolveMascotStyle,
  type BotAvatarChoice,
  type BotAvatarId,
  type BotAvatarCrop,
  type MascotStyle,
} from "../../shared/bot-avatar";
import { OrbitRingFrame, workingRingStyle } from "./OrbitRing";

export type MausAvatarHandle = {
  blink: () => void;
  spin: (durationMs?: number) => void;
  setExpression: (index: number) => void;
};

export type MausAvatarProps = {
  color: MausColor;
  mascotStyle?: MascotStyle | string | null;
  state?: MausState;
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  forward?: boolean;
  lookAround?: number;
  trackPointer?: boolean;
  animated?: boolean;
  eyeSpacing?: number;
  faceX?: number;
  faceY?: number;
  faceScale?: number;
};

function motionDelay(style: string, color: string): { idle: string; blink: string } {
  let n = 0;
  const key = `${style}:${color}`;
  for (let i = 0; i < key.length; i++) n = (n * 33 + key.charCodeAt(i)) >>> 0;
  return { idle: `${(n % 80) / 10}s`, blink: `${((n >> 3) % 54) / 10}s` };
}

function MausAvatarComponent(
  { color, mascotStyle, size = 44, label, animated, motion }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const reactId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudgeEnd = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
  }, []);

  useImperativeHandle(ref, () => ({
    blink: () => {
      const el = rootRef.current;
      if (!el) return;
      const finish = () => {
        el.classList.remove("mascot-avatar--nudge");
        if (nudgeEnd.current) {
          el.removeEventListener("animationend", nudgeEnd.current);
          nudgeEnd.current = null;
        }
        if (nudgeTimer.current) {
          clearTimeout(nudgeTimer.current);
          nudgeTimer.current = null;
        }
      };
      finish();
      void el.offsetWidth;
      el.classList.add("mascot-avatar--nudge");
      nudgeEnd.current = finish;
      el.addEventListener("animationend", finish);
      nudgeTimer.current = setTimeout(finish, 220);
    },
    spin: () => {},
    setExpression: () => {},
  }));

  const style = resolveMascotStyle(mascotStyle, color);
  const markup = useMemo(
    () => mascotLayerMarkup(scopeMascotSvgIds(mascotSvgMarkup(style, color), reactId)),
    [style, color, reactId],
  );
  const delay = motionDelay(style, color);
  const still = animated === false || motion === "none";
  return (
    <span
      ref={rootRef}
      className={`mascot-avatar inline-flex shrink-0${still ? " mascot-avatar--still" : ""}`}
      role="img"
      aria-label={label ?? `${style} mascot`}
      style={
        {
          width: size,
          height: size,
          "--mascot-idle-delay": delay.idle,
          "--mascot-blink-delay": delay.blink,
        } as CSSProperties
      }
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color" | "mascotStyle"> & {
  bot: {
    name?: string;
    color: MausColor;
    mascotStyle?: BotAvatarChoice | string | null;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
  };
  /** Working-row only. Other call sites leave this off. */
  orbitRing?: boolean;
};

/** Wink logo by color family, for a bot with no stored pick or a lost image. */
function winkFallback(color: string | null | undefined): BotAvatarId {
  switch (color) {
    case "red":
    case "orange":
    case "yellow":
    case "pink":
    case "coral":
      return "icon-34";
    case "green":
    case "teal":
    case "cyan":
      return "icon-33";
    case "blue":
    case "purple":
      return "icon-35";
    case "white":
    case "gray":
      return "icon-32";
    default:
      return "icon-31";
  }
}

/**
 * The one renderer for a bot's chosen profile image. Malformed persisted
 * values and images that fail to load both fall back to the Wink logo,
 * so an old/corrupt profile can never leave a broken-image icon in the app.
 */
export function BotAvatar({ bot, size = 44, label, orbitRing = false, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);
  const [presetFailed, setPresetFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
    setPresetFailed(false);
  }, [profile.avatarUrl, profile.mascotStyle]);

  const image = profile.avatarCrop !== "mascot" && Boolean(profile.avatarUrl) && !imageFailed;
  // only a stored legacy pick still draws the old mascot
  const legacy = !image && !imageFailed && mascotStyleSchema.safeParse(bot.mascotStyle).success;
  const fallback = winkFallback(bot.color);
  const icon = isBotAvatarId(profile.mascotStyle) && !presetFailed ? profile.mascotStyle : fallback;
  let face: ReactNode;
  if (legacy) {
    face = (
      <MausAvatar
        {...mascotProps}
        color={bot.color}
        mascotStyle={resolveMascotStyle(profile.mascotStyle, bot.color)}
        size={size}
        label={label ?? bot.name}
      />
    );
  } else if (!image) {
    face = (
      <img
        src={botAvatarAssetPath(icon)}
        alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
        width={size}
        height={size}
        draggable={false}
        onError={icon === fallback ? undefined : () => setPresetFailed(true)}
        className="block shrink-0"
        style={{ width: size, height: size }}
      />
    );
  } else {
    const radius =
      profile.avatarCrop === "circle"
        ? "50%"
        : profile.avatarCrop === "rounded"
          ? "22%"
          : "0";
    face = (
      <img
        src={profile.avatarUrl}
        alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
        width={size}
        height={size}
        draggable={false}
        onError={() => setImageFailed(true)}
        className="block shrink-0 bg-raised object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }

  if (!orbitRing) return face;
  return (
    <OrbitRingFrame
      style={workingRingStyle({
        size,
        crop: profile.avatarCrop,
        mascotStyle: legacy ? profile.mascotStyle : icon,
        image,
      })}
    >
      {face}
    </OrbitRingFrame>
  );
}

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
export function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

export function InitialsAvatar({
  initials,
  imageUrl,
  size = 32,
  pending = false,
}: {
  initials: string;
  imageUrl?: string;
  size?: number;
  pending?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  if (pending) {
    return <div aria-hidden="true" className="shrink-0 animate-pulse rounded-full bg-raised motion-reduce:animate-none" style={{ width: size, height: size }} />;
  }
  if (imageUrl && !imageFailed) {
    return (
      <img
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setImageFailed(true)}
        className="block shrink-0 rounded-full bg-raised object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
