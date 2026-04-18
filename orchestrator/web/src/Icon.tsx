type IconName =
  | "home"
  | "settings"
  | "plus"
  | "folder"
  | "play"
  | "square"
  | "refresh"
  | "trash"
  | "github"
  | "git-branch"
  | "git-pull"
  | "message"
  | "send"
  | "check"
  | "x"
  | "lock"
  | "external"
  | "chevron-right"
  | "send-plane"
  | "sparkles"
  | "wrench"
  | "user"
  | "bot"
  | "arrow-left"
  | "pencil"
  | "bell"
  | "dot";

const paths: Record<IconName, string> = {
  home: "M3 12 L12 3 L21 12 M5 10v10h4v-6h6v6h4V10",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  plus: "M12 5v14 M5 12h14",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  play: "M6 4l14 8-14 8z",
  square: "M6 6h12v12H6z",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5",
  trash:
    "M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6",
  github:
    "M9 19c-4 1.5-4-2-6-2 M15 22v-3.9a3.4 3.4 0 0 0-.9-2.5c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 18.9 5 4.9 4.9 0 0 0 18.8 1.2s-1.2-.4-3.8 1.4A13.2 13.2 0 0 0 12 2.2c-1 0-2 .1-3 .4C6.4.8 5.2 1.2 5.2 1.2A4.9 4.9 0 0 0 5.1 5a5.2 5.2 0 0 0-1.4 3.6c0 5.2 3.2 6.4 6.2 6.7a3.4 3.4 0 0 0-.9 2.5V22",
  "git-branch": "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M15 6a9 9 0 0 0-9 9",
  "git-pull":
    "M18 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 15v6 M6 9v12 M13 6h3a2 2 0 0 1 2 2v1",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  send: "M22 2 11 13 M22 2l-7 20-4-9-9-4z",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18 M6 6l12 12",
  lock: "M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14 21 3",
  "chevron-right": "M9 18l6-6-6-6",
  "send-plane": "M22 2 11 13 M22 2l-7 20-4-9-9-4z",
  sparkles:
    "M12 3l1.9 5.5L19 10l-5.1 1.5L12 17l-1.9-5.5L5 10l5.1-1.5z M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z M5 3l.6 1.6L7 5l-1.4.4L5 7l-.6-1.6L3 5l1.4-.4z",
  wrench:
    "M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-10-10L6.3 9.7a4 4 0 0 0 5-5z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  bot: "M12 8V4H8 M5 12h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z M2 14h2 M20 14h2 M15 13v2 M9 13v2",
  "arrow-left": "M19 12H5 M12 19l-7-7 7-7",
  pencil: "M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0",
  dot: "M12 12h.01",
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
