/**
 * ไอคอน inline SVG — DS §5.14 (Lucide style · viewBox 0 0 24 24 · stroke 1.8 · currentColor)
 * ใช้เฉพาะในขอบเขต lane C-6 (components/course + หน้าแคตตาล็อก)
 */

type IconProps = {
  /** ค่าเริ่มต้น 20px (body) — DS §5.14 */
  className?: string;
  size?: number;
};

function iconProps(className: string | undefined, size: number) {
  return {
    className,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
  } as const;
}

export function SearchIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function ClockIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function BookOpenIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

export function FileTextIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

export function ListChecksIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  );
}

export function UsersIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function AwardIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.5 13 17 22l-5-3-5 3 1.5-9" />
    </svg>
  );
}

export function PlayIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <circle cx="12" cy="12" r="10" />
      <path d="m10 8 6 4-6 4z" />
    </svg>
  );
}

export function GraduationCapIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <path d="M22 10 12 5 2 10l10 5 10-5" />
      <path d="M6 12.5V17c0 1.66 2.69 3 6 3s6-1.34 6-3v-4.5" />
      <path d="M22 10v6" />
    </svg>
  );
}

export function ChevronRightIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function CheckCircleIcon({ className, size = 20 }: IconProps) {
  return (
    <svg {...iconProps(className, size)}>
      <path d="M21.8 10A10 10 0 1 1 17 3.34" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}
