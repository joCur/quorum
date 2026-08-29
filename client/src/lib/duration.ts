/** `h:mm:ss` past an hour, `mm:ss` below it — always with tabular figures. */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Rounded seconds for buffer counters, e.g. "14s". */
export function roundSeconds(seconds: number): number {
  return Math.max(0, Math.round(seconds));
}
