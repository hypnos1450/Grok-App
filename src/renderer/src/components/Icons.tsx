// Shared stroke-based SVG icon set. Replaces the old unicode glyphs (⚙ ⌕ ⇤ ＋ ✕ …)
// which rendered tiny and inconsistently across platforms. All icons inherit
// `currentColor` and default to 18px so they read clearly inside icon buttons.
interface IconProps {
  size?: number
  strokeWidth?: number
}

function Base(
  { size = 18, strokeWidth = 1.7 }: IconProps,
  children: JSX.Element | JSX.Element[]
): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function GearIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.4l.9 2.1a5.7 5.7 0 0 1 2 .84l2.2-.63 1.5 2.6-1.55 1.7a5.8 5.8 0 0 1 0 1.98l1.55 1.7-1.5 2.6-2.2-.63a5.7 5.7 0 0 1-2 .84L10 17.6l-.9-2.1a5.7 5.7 0 0 1-2-.84l-2.2.63-1.5-2.6 1.55-1.7a5.8 5.8 0 0 1 0-1.98l-1.55-1.7 1.5-2.6 2.2.63a5.7 5.7 0 0 1 2-.84L10 2.4Z" />
    </>
  )
}

export function SearchIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <circle cx="8.8" cy="8.8" r="5.3" />
      <path d="M13 13l4.2 4.2" />
    </>
  )
}

/** Sidebar toggle: panel outline with the left column filled. */
export function PanelLeftIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.2" />
      <path d="M7.5 3.5v13" />
    </>
  )
}

export function PlusIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M10 4.2v11.6M4.2 10h11.6" />
  )
}

export function CheckIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M3.8 10.6l4 4 8.4-9.2" />
  )
}

export function XIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M5.2 5.2l9.6 9.6M14.8 5.2l-9.6 9.6" />
  )
}

export function PencilIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M12.9 3.6l3.5 3.5L7 16.5l-4.3 1 1-4.3 9.2-9.6ZM11.5 5.2l3.3 3.3" />
  )
}

export function ForkIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <circle cx="5.5" cy="4.5" r="1.9" />
      <circle cx="14.5" cy="4.5" r="1.9" />
      <circle cx="10" cy="15.5" r="1.9" />
      <path d="M5.5 6.4v1.2a3 3 0 0 0 3 3h3a3 3 0 0 0 3-3V6.4M10 10.6v3" />
    </>
  )
}

export function RefreshIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M16.4 8.2a6.6 6.6 0 1 0 .35 3.6" />
      <path d="M16.9 3.4v4.8h-4.8" />
    </>
  )
}

export function UndoIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M3.4 8.3h8a5 5 0 0 1 0 10h-4" />
      <path d="M7 4.7L3.4 8.3 7 11.9" />
    </>
  )
}

export function ExpandIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M11.8 3.5h4.7v4.7M16.5 3.5l-5.3 5.3" />
      <path d="M8.2 16.5H3.5v-4.7M3.5 16.5l5.3-5.3" />
    </>
  )
}

export function ShrinkIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M8.5 3.2v5.3H3.2M8.5 8.5L3 3" />
      <path d="M11.5 16.8v-5.3h5.3M11.5 11.5l5.5 5.5" />
    </>
  )
}

export function SendIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M10 16V4.5M10 4.5L4.8 9.7M10 4.5l5.2 5.2" />
  )
}

export function StopIcon(p: IconProps = {}): JSX.Element {
  return (
    <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <rect x="5.5" y="5.5" width="9" height="9" rx="2" />
    </svg>
  )
}

export function QueueIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M4 5h12M4 9.5h7" />
      <path d="M14.5 8.5v7M14.5 15.5l-3-3M14.5 15.5l3-3" />
    </>
  )
}

export function WarnIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M10 3.2L18 16.4H2L10 3.2Z" />
      <path d="M10 8.2v3.6" />
      <circle cx="10" cy="14" r="0.9" fill="currentColor" stroke="none" />
    </>
  )
}

export function HomeIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M3.2 8.6L10 3l6.8 5.6M4.8 7.8v8a1.2 1.2 0 0 0 1.2 1.2h2.6v-4.6h2.8V17H14a1.2 1.2 0 0 0 1.2-1.2v-8" />
  )
}

export function FolderIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M2.5 6v9.2a1.3 1.3 0 0 0 1.3 1.3h12.4a1.3 1.3 0 0 0 1.3-1.3V7.8a1.3 1.3 0 0 0-1.3-1.3H10L8.2 4.7H3.8a1.3 1.3 0 0 0-1.3 1.3Z" />
  )
}

export function FolderPlusIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M2.5 6v9.2a1.3 1.3 0 0 0 1.3 1.3h12.4a1.3 1.3 0 0 0 1.3-1.3V7.8a1.3 1.3 0 0 0-1.3-1.3H10L8.2 4.7H3.8a1.3 1.3 0 0 0-1.3 1.3Z" />
      <path d="M10 9.2v4.4M7.8 11.4h4.4" />
    </>
  )
}

export function MessageIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M10 3.2c4.1 0 7.4 2.8 7.4 6.3s-3.3 6.3-7.4 6.3c-.9 0-1.7-.1-2.5-.4L3.4 16.8l1-3.2a6 6 0 0 1-1.8-4.1c0-3.5 3.3-6.3 7.4-6.3Z" />
  )
}

export function BoltIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M11 2.6L4.4 11.4h4.2L9 17.4l6.6-8.8h-4.2L11 2.6Z" />
  )
}

export function CalendarIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <rect x="3" y="4.6" width="14" height="12.4" rx="1.6" />
      <path d="M3 8.4h14M6.8 2.8v3M13.2 2.8v3" />
    </>
  )
}

export function ClockIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 5.8V10l2.8 1.9" />
    </>
  )
}

export function ArrowRightIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <path d="M4 10h11M11.5 5.5L16 10l-4.5 4.5" />
  )
}

// ------------------------------------------------------- welcome starters

export function CompassIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <circle cx="10" cy="10" r="7.3" />
      <path d="M13.2 6.8l-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9Z" />
    </>
  )
}

export function BugIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M7.4 6.2a2.6 2.6 0 0 1 5.2 0" />
      <rect x="6.4" y="6.2" width="7.2" height="9" rx="3.6" />
      <path d="M10 8.5v6.7" />
      <path d="M6.4 9H3.2M6.4 12h-3M16.8 9h-3.2M16.7 12h-3" />
      <path d="M7.2 6l-1.7-1.7M12.8 6l1.7-1.7" />
    </>
  )
}

export function BookIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M10 5.2C8.7 4 6.9 3.5 4.5 3.5c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1 2.4 0 4.2.5 5.5 1.7 1.3-1.2 3.1-1.7 5.5-1.7.6 0 1-.4 1-1v-10c0-.6-.4-1-1-1-2.4 0-4.2.5-5.5 1.7Z" />
      <path d="M10 5.2v12" />
    </>
  )
}

export function FlaskIcon(p: IconProps = {}): JSX.Element {
  return Base(
    p,
    <>
      <path d="M8 3h4M8.7 3.2v4.6L4 15.5a1.6 1.6 0 0 0 1.4 2.4h9.2a1.6 1.6 0 0 0 1.4-2.4L11.3 7.8V3.2" />
      <path d="M6.2 12.5h7.6" />
    </>
  )
}
