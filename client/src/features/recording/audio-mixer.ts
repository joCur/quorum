/**
 * One track out of two sources.
 *
 * An online meeting has two halves that the recorder must hear as one conversation: the people in
 * the room, through the microphone, and the people in the call, through the shared display audio.
 * They are summed in a WebAudio graph and leave it as a single track, so everything downstream —
 * `MediaRecorder`, the chunk protocol, the server, the transcript — is untouched. No protocol
 * change, no second stream, no second session: the pipeline never learns that this recording had
 * two microphones behind it.
 *
 * The analyser hangs off the sum rather than off either input, which is what makes the level meter
 * and the breathing indicator report the signal that is actually being recorded.
 *
 * Gains are deliberately unity. The display feed is already normalized by the meeting app that
 * produced it, and quietly ducking one side of a conversation to make a meter look tidy would be
 * the kind of invisible processing this product does not do.
 */

export interface AudioMixer {
  /** The single-track stream to hand to `MediaRecorder`. */
  readonly stream: MediaStream;
  /** Reads the mixed signal, for the level meter. */
  readonly analyser: AnalyserNode;
  readonly context: AudioContext;
  /** Adds a source to the running mix — used when the microphone is swapped mid-recording. */
  addSource(stream: MediaStream): void;
  /** Tears the graph down. Source tracks belong to the caller and are not stopped here. */
  close(): Promise<void>;
}

/** How much of the signal the analyser looks at; matches the microphone-only path. */
const FFT_SIZE = 1024;

/**
 * Builds the mixing graph over the given sources.
 *
 * The `AudioContext` is injected rather than constructed inline so the plumbing can be tested
 * against a fake — a real context in a unit test would need an audio device that CI does not have.
 */
export function createAudioMixer(
  sources: readonly MediaStream[],
  createContext: () => AudioContext = () => new AudioContext(),
): AudioMixer {
  const context = createContext();
  const destination = context.createMediaStreamDestination();
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  // The analyser sits alongside the destination rather than in front of it: it is a tap on the
  // sum, not a stage of it, so nothing it does can affect what is recorded. The graph is pulled by
  // the destination, exactly as the microphone-only path is pulled by its own stream.

  const attached: AudioNode[] = [];

  const addSource = (stream: MediaStream) => {
    if (stream.getAudioTracks().length === 0) return;
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(destination);
    gain.connect(analyser);
    attached.push(source, gain);
  };

  for (const stream of sources) addSource(stream);

  return {
    stream: destination.stream,
    analyser,
    context,
    addSource,
    close: async () => {
      for (const node of attached) node.disconnect();
      attached.length = 0;
      await context.close().catch(() => undefined);
    },
  };
}

/**
 * Turns capture on and off at the source.
 *
 * Pausing the `MediaRecorder` already stops audio reaching the file, but it leaves both inputs
 * live: the microphone light stays on and the meter keeps moving while the screen says the
 * recording is paused. Disabling the tracks themselves is what makes the pause mean what the
 * screen claims — for the room and for the call alike.
 */
export function setCaptureEnabled(
  streams: readonly (MediaStream | null)[],
  enabled: boolean,
): void {
  for (const stream of streams) {
    for (const track of stream?.getAudioTracks() ?? []) track.enabled = enabled;
  }
}
