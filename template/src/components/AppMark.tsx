interface AppMarkProps {
  size?: number;
  className?: string;
}

/** The app icon (public/icon.svg). Replace that file to change it everywhere. */
export function AppMark({ size = 32, className = "" }: AppMarkProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG; next/image adds nothing here
    <img
      src="/icon.svg"
      alt=""
      width={size}
      height={size}
      className={`app-mark rounded-lg shrink-0 ${className}`.trim()}
      aria-hidden
    />
  );
}
