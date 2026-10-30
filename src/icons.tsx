// Small line icons used across the app. All draw in currentColor so they
// follow whatever text colour the surrounding button sets.

type IconProps = { size?: number };

const svgProps = (size: number) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
});

export const MicIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </svg>
);

export const StopIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
  </svg>
);

export const SendIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)} strokeWidth={2.4}>
    <path d="M12 19V5" />
    <path d="M6 11l6-6 6 6" />
  </svg>
);

export const NewChatIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    <path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
  </svg>
);

export const InfoIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </svg>
);

export const EyeIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const EyeOffIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.4 3.4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="M3 3l18 18" />
  </svg>
);

export const CalendarIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
    <path d="M9 15l2 2 4-4" />
  </svg>
);

export const ClockIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const ChevronIcon = ({ size = 16, dir = "left" }: IconProps & { dir?: "left" | "right" }) => (
  <svg {...svgProps(size)}>
    <path d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
  </svg>
);

export const LockIcon = ({ size = 14, locked }: IconProps & { locked: boolean }) => (
  <svg {...svgProps(size)}>
    <rect x="4" y="11" width="16" height="10" rx="2" fill={locked ? "currentColor" : "none"} />
    <path d={locked ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7.8-1.2"} />
  </svg>
);

/** ROAM connection status, shown as a single icon in the header. */
export const ConnectionIcon = ({ size = 18, state }: IconProps & { state: "connected" | "connecting" | "error" | "disconnected" }) => {
  if (state === "connected") return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
      <path d="M7.5 12.5l3 3 6-6.5" stroke="#FFFFFF" strokeWidth={2.4} />
    </svg>
  );
  if (state === "error") return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
      <path d="M12 7v6" stroke="#FFFFFF" strokeWidth={2.4} />
      <path d="M12 16.5h.01" stroke="#FFFFFF" strokeWidth={2.8} />
    </svg>
  );
  if (state === "connecting") return (
    <svg {...svgProps(size)} style={{ animation: "roam-spin 0.9s linear infinite" }}>
      <circle cx="12" cy="12" r="9" opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
  // Disconnected: an unplugged plug
  return (
    <svg {...svgProps(size)}>
      <path d="M9 2v5M15 2v5" />
      <path d="M6 7h12v4a6 6 0 0 1-12 0z" />
      <path d="M12 17v5" />
    </svg>
  );
};
