import { AudioPlayer } from "@quorum/client";

// A 0.1 s silent WAV, so the element has a real, decodable source without a network request.
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

const frame: React.CSSProperties = { maxWidth: 560 };

const noop = (): void => undefined;

export function Ready() {
  return (
    <div style={frame}>
      <AudioPlayer
        url={SILENCE}
        status="ready"
        fallbackDuration={2732}
        onTimeUpdate={noop}
        onRetry={noop}
      />
    </div>
  );
}

export function Loading() {
  return (
    <div style={frame}>
      <AudioPlayer
        url={null}
        status="loading"
        fallbackDuration={null}
        onTimeUpdate={noop}
        onRetry={noop}
      />
    </div>
  );
}

export function Unavailable() {
  return (
    <div style={frame}>
      <AudioPlayer
        url={null}
        status="error"
        fallbackDuration={1815}
        onTimeUpdate={noop}
        onRetry={noop}
      />
    </div>
  );
}
