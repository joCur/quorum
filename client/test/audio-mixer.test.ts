import { describe, expect, it, vi } from "vitest";
import { createAudioMixer, setCaptureEnabled } from "@/features/recording/audio-mixer";

/**
 * The mixer is the one place where an online recording stops being two things.
 *
 * These tests are about the shape of the graph rather than about sound: what matters is that both
 * sources reach the destination, that the analyser sees the sum rather than one half of it, and
 * that closing releases everything. A real `AudioContext` is not available in jsdom and would not
 * make these claims any more true, so the context is a fake that records what was wired to what.
 */

interface FakeNode {
  kind: string;
  connectedTo: FakeNode[];
  connect: (target: FakeNode) => FakeNode;
  disconnect: () => void;
  disconnected: boolean;
}

function node(kind: string, extra: Record<string, unknown> = {}): FakeNode {
  const it: FakeNode = {
    kind,
    connectedTo: [],
    disconnected: false,
    connect(target: FakeNode) {
      it.connectedTo.push(target);
      return target;
    },
    disconnect() {
      it.disconnected = true;
    },
    ...extra,
  } as FakeNode;
  return it;
}

function fakeStream(audioTracks: number, id = "stream"): MediaStream {
  const tracks = Array.from({ length: audioTracks }, (_value, index) => ({
    kind: "audio",
    id: `${id}-${index}`,
    enabled: true,
  }));
  return {
    id,
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

function fakeContext() {
  const destinationStream = fakeStream(1, "mixed");
  const destination = node("destination", { stream: destinationStream });
  const analyser = node("analyser", { fftSize: 0 });
  const sources: { stream: MediaStream; node: FakeNode }[] = [];
  const gains: FakeNode[] = [];
  const close = vi.fn(async () => undefined);

  const context = {
    sampleRate: 48_000,
    createMediaStreamDestination: () => destination,
    createAnalyser: () => analyser,
    createMediaStreamSource: (stream: MediaStream) => {
      const created = node("source");
      sources.push({ stream, node: created });
      return created;
    },
    createGain: () => {
      const gain = node("gain", { gain: { value: 0 } });
      gains.push(gain);
      return gain;
    },
    close,
  };

  return {
    context: context as unknown as AudioContext,
    destination,
    analyser,
    sources,
    gains,
    close,
  };
}

describe("mixing the microphone with the meeting's own sound", () => {
  it("sums both sources into the one track the recorder is given", () => {
    const fake = fakeContext();
    const mic = fakeStream(1, "mic");
    const display = fakeStream(1, "display");

    const mixer = createAudioMixer([mic, display], () => fake.context);

    // Both inputs entered the graph…
    expect(fake.sources.map((each) => each.stream)).toEqual([mic, display]);
    // …and both of them reach the destination, which is what "one track" means here.
    expect(fake.gains).toHaveLength(2);
    for (const gain of fake.gains) {
      expect(gain.connectedTo).toContain(fake.destination);
    }
    // The stream handed on is the graph's output, not either input.
    expect(mixer.stream).toBe((fake.destination as unknown as { stream: MediaStream }).stream);
    expect(mixer.stream).not.toBe(mic);
    expect(mixer.stream).not.toBe(display);
  });

  it("meters the sum, so the level is the signal that is actually recorded", () => {
    const fake = fakeContext();
    createAudioMixer([fakeStream(1, "mic"), fakeStream(1, "display")], () => fake.context);

    // Every source reaches the analyser too — a meter fed by the microphone alone would sit still
    // through a call in which only the remote participants are speaking.
    for (const gain of fake.gains) {
      expect(gain.connectedTo).toContain(fake.analyser);
    }
    expect((fake.analyser as unknown as { fftSize: number }).fftSize).toBe(1024);
  });

  it("passes both sources through at unity, adding no processing of its own", () => {
    const fake = fakeContext();
    createAudioMixer([fakeStream(1, "mic"), fakeStream(1, "display")], () => fake.context);

    for (const gain of fake.gains) {
      expect((gain as unknown as { gain: { value: number } }).gain.value).toBe(1);
    }
  });

  it("ignores a source that carries no audio", () => {
    const fake = fakeContext();
    createAudioMixer([fakeStream(1, "mic"), fakeStream(0, "silent")], () => fake.context);

    expect(fake.sources).toHaveLength(1);
    expect(fake.gains).toHaveLength(1);
  });

  it("takes a microphone swap without rebuilding the session", () => {
    const fake = fakeContext();
    const mixer = createAudioMixer([fakeStream(1, "mic")], () => fake.context);
    const before = mixer.stream;

    mixer.addSource(fakeStream(1, "replacement"));

    expect(fake.sources).toHaveLength(2);
    // The track the recorder holds is the same one — which is exactly why a swap costs no chunks.
    expect(mixer.stream).toBe(before);
  });

  it("disconnects the graph and closes the context when the recording ends", async () => {
    const fake = fakeContext();
    const mixer = createAudioMixer(
      [fakeStream(1, "mic"), fakeStream(1, "display")],
      () => fake.context,
    );

    await mixer.close();

    expect(fake.sources.every((each) => each.node.disconnected)).toBe(true);
    expect(fake.gains.every((gain) => gain.disconnected)).toBe(true);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("survives a context that refuses to close", async () => {
    const fake = fakeContext();
    fake.close.mockRejectedValueOnce(new Error("already closed"));
    const mixer = createAudioMixer([fakeStream(1, "mic")], () => fake.context);

    // A teardown that threw here would leave the recording screen in a failed state over a
    // resource that is already gone.
    await expect(mixer.close()).resolves.toBeUndefined();
  });
});

describe("pausing means both sources stop listening", () => {
  it("disables and re-enables every audio track it is given", () => {
    const mic = fakeStream(1, "mic");
    const display = fakeStream(2, "display");

    setCaptureEnabled([mic, display], false);
    expect([...mic.getAudioTracks(), ...display.getAudioTracks()].every((t) => !t.enabled)).toBe(
      true,
    );

    setCaptureEnabled([mic, display], true);
    expect([...mic.getAudioTracks(), ...display.getAudioTracks()].every((t) => t.enabled)).toBe(
      true,
    );
  });

  it("tolerates a capture that has no display half", () => {
    const mic = fakeStream(1, "mic");
    expect(() => setCaptureEnabled([mic, null], false)).not.toThrow();
    expect(mic.getAudioTracks()[0]?.enabled).toBe(false);
  });
});
