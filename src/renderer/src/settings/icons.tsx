/** Minimal stroke icons so the app carries no icon-font dependency. */
interface IconProps {
  size?: number
}

function svg(path: JSX.Element, size = 16): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  )
}

export function IconHome({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" />
    </>,
    size
  )
}

/**
 * Three bars of unequal height: the icon for the overview page, which opens on
 * a bar chart of the last seven days.
 */
export function IconChart({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M5 20V12.5M12 20V5M19 20v-5.5" />
    </>,
    size
  )
}

export function IconClock({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 1.8" />
    </>,
    size
  )
}

export function IconBook({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18v15H6.5A1.5 1.5 0 0 0 5 20.5z" />
      <path d="M8 8h6M8 12h5" />
    </>,
    size
  )
}

export function IconGear({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M4.6 7.8l1.7 1M17.7 15.2l1.7 1M4.6 16.2l1.7-1M17.7 8.8l1.7-1" />
    </>,
    size
  )
}

/**
 * Eight-tooth cog with a bore hole. `IconGear` above is only a circle with six
 * short spokes, which reads as a sunburst when it sits next to `IconSun` in the
 * sidebar footer, so the sidebar entry needs a heavier, unmistakably cog-shaped
 * silhouette. Kept as a separate export so existing `IconGear` call sites in the
 * settings sections are untouched.
 */
export function IconSettings({ size }: IconProps): JSX.Element {
  const teeth = 8
  const outer = 9.4
  const inner = 7.1
  // Each tooth is a trapezoid: two points at the outer radius, two at the root.
  const edges: ReadonlyArray<readonly [number, number]> = [
    [-19, inner],
    [-10, outer],
    [10, outer],
    [19, inner]
  ]
  const points: string[] = []
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    const centre = (tooth * 360) / teeth
    for (const [offset, radius] of edges) {
      const angle = ((centre + offset) * Math.PI) / 180
      const x = 12 + radius * Math.cos(angle)
      const y = 12 + radius * Math.sin(angle)
      points.push(`${x.toFixed(2)} ${y.toFixed(2)}`)
    }
  }
  return svg(
    <>
      <path d={`M${points.join('L')}Z`} />
      <circle cx="12" cy="12" r="3" />
    </>,
    size
  )
}

export function IconFolder({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M4 7a1 1 0 0 1 1-1h4l1.6 2H19a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    </>,
    size
  )
}

export function IconMic({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <rect x="9" y="3.5" width="6" height="10" rx="3" />
      <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
    </>,
    size
  )
}

export function IconSearch({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>,
    size
  )
}

export function IconCheck({ size }: IconProps): JSX.Element {
  return svg(<path d="M4.5 12.5 L9.5 17.5 L19.5 6.5" />, size)
}
export function IconCopy({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <rect x="9" y="9" width="10" height="11" rx="2" />
      <path d="M15 6.5A2.5 2.5 0 0 0 12.5 4H7a2 2 0 0 0-2 2v8" />
    </>,
    size
  )
}

export function IconTrash({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
    </>,
    size
  )
}

export function IconPlus({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M12 6v12M6 12h12" />
    </>,
    size
  )
}

export function IconSun({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>,
    size
  )
}

export function IconMoon({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M20 14.2A8 8 0 0 1 9.8 4 8.2 8.2 0 1 0 20 14.2z" />
    </>,
    size
  )
}

export function IconSparkles({ size }: IconProps): JSX.Element {
  return svg(
    <>
      <path d="M12 4.5 13.4 9l4.5 1.4-4.5 1.4L12 16.3l-1.4-4.5L6.1 10.4 10.6 9z" />
      <path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </>,
    size
  )
}
