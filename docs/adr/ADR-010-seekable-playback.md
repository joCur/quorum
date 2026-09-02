# ADR-010: Seekable Playback for Incrementally Written Recordings

**Status:** Proposed · **Date:** 2026-09-02

## Context

ADR-002 has the browser stream `MediaRecorder` output in 1–2 s slices, and ADR-001 has the server
persist each slice as its own object under the session prefix. Playback reads that layout back:
the meetings audio endpoint lists the chunk objects, computes each one's offset in the
concatenated stream, resolves the HTTP `Range` header against the total, and streams only the
slices the range touches. Nothing is written back, which is what keeps the chunk objects the
single copy of the audio and the deletion cascade a plain prefix removal.

The byte-range half of that is correct. The container half is not. `MediaRecorder` writes a live
stream: the Segment has unknown size, every Cluster has unknown size, there is no Duration in the
Segment Info, and there is no Cues element — because a Cues element records byte offsets, and a
live writer does not know them until it is finished. Concatenating the chunks reproduces that
stream faithfully, including everything it is missing. A player therefore has no map from a point
in time to a byte offset, and no total length to draw a timeline against.

Two further facts frame the decision.

First, the client does not use the range endpoint at all today. The audio endpoint requires an
access token and a media element cannot send an `Authorization` header, so the client fetches the
whole recording with `fetch`, wraps it in an object URL, and hands that to `<audio>`. With every
byte already in memory the browser can seek, which is why the defect is not currently visible as
"seeking is broken" — it is visible as a recording that must download in full before it plays, and
as a player that reads `duration` as `Infinity` and falls back to the length the transcript
reports. Fixing the container is what makes streaming playback possible; it does not by itself
make it happen.

Second, stored audio is load-bearing for three of the four critical paths. Crash recovery rebuilds
`persistedSeq` from a listing of the chunk prefix. The transcription worker reads the chunk objects
named in the manifest. Deletion removes everything under the session prefix. Any change to what is
stored has to leave all three intact, and it has to do so without keeping a second permanent copy
of the audio, which is the dominant storage cost.

## Measurements

Measured on a real Chromium `MediaRecorder` stream — Opus in WebM, 1 s timeslice, ~33 kbit/s,
one chunk object per `dataavailable` event, exactly the shape the recording endpoint stores.
Remuxing was `ffmpeg -i in.webm -c copy -f webm out.webm` (FFmpeg 9.0, stream copy, no decode).

| | incrementally written | remuxed |
| --- | --- | --- |
| Bytes | 1,227,815 | 1,225,101 (**−0.22 %**) |
| Segment size | unknown | declared |
| Cluster sizes | all unknown | all declared |
| Clusters | 293 (one per chunk, ~1.02 s apart) | 60 (~4.98 s apart) |
| Cues element | absent | present, 1,187 bytes (0.1 %) |
| Duration in Info | absent | 298.676 s |
| `ffprobe` duration | `N/A` | 298.676 |
| Chromium `<audio>.duration` | `Infinity` | 298.676 |
| Chromium `seekable` | `[0, Infinity]` | `[0, 298.676]` |
| Seek to 250 s over ranged HTTP | 89 ms | 6 ms |

Three results decide the ADR.

**The remuxed file is smaller than the original.** Declaring cluster sizes and coalescing 293
one-second clusters into 60 five-second ones saves more header bytes than the 1,187-byte Cues
element costs. Replacing the chunk objects with one remuxed object is not a storage cost at all;
it is a small storage saving, plus 293 fewer objects to list, bill and delete.

**The remux is essentially free and lossless.** Three runs of the five-minute recording took 36,
28 and 23 ms — roughly 12,000× realtime, so a two-hour recording extrapolates to well under a
second of CPU. Decoding both files to raw PCM gives the same MD5, so the Opus packets survive
bit-identically; this is a repackaging, not a re-encode.

**A cue sidecar is buildable but cannot be consumed by a plain player.** A pure-JavaScript EBML
pass over the concatenated stream finds all 293 cluster boundaries and their timestamps in one
sequential read; the resulting index is 4.6 kB of JSON for five minutes, so about 110 kB for two
hours, and far less in a delta-encoded binary form. But `<audio>` cannot be told about an external
index. Using one means the client drives Media Source Extensions itself: fetch the initialization
bytes, then fetch and append the byte range for the cluster containing the seek target, and manage
the SourceBuffer's memory across a two-hour recording.

Not measured: Firefox and WebKit. Only Chromium is installed in this environment, and the
Playwright Firefox build failed to load either file, so that run says nothing about either
container. The reasoning above rests on the Matroska container specification, which is
engine-independent, but the browser numbers in the table are Chromium's alone.

## Options

**A — Remux on finalize, replacing the chunk objects.** A server-side job repackages the chunks
into one seekable WebM, verifies it, points the manifest at it and deletes the chunks. Storage:
slightly negative, no second permanent copy. CPU: sub-second per recording, paid once, off the
recording path. Complexity: one new job type, one manifest field, one branch in each of the two
readers. Failure mode: the job fails or the process dies mid-way, and the chunk objects are still
there — playback and transcription carry on exactly as today, which makes every failure a
non-event as long as the chunks are deleted last and only after the new object has been verified.

**B — Cue sidecar plus a Media Source Extensions player.** A small index object next to the chunks;
the client seeks by fetching ranges and appending them itself. Storage: about 110 kB per two-hour
recording — negligible, and it is the only option that adds a permanent object. CPU: one sequential
scan on finalize, comparable to the remux. Complexity: this is the expensive one, and the expense
is all in the client. Buffer management, the seek-while-seeking case, playback-rate changes,
`Infinity` duration still needing a separate source of truth, and a second code path for Safari's
MP4 recordings, which are a different byte stream format. Failure modes are client-side and hard
to observe from the server.

**C — Remux on demand, cached.** The first playback request triggers the repackaging; the result
is cached and evicted. Avoids touching the stored recording, so all four critical paths are
untouched by construction. But the cache is either a second full copy of every recently played
recording — the thing the guardrail rules out — or it is small enough to thrash, in which case a
user who plays a two-hour meeting twice pays for it twice. It also puts a job on the read path,
where its latency and its failures are the user's problem, and it contradicts the rule that every
long-running operation is a server-side job rather than something a request waits on.

## Decision

**Take option A.** On finalize, the recording is losslessly remuxed into a single seekable WebM
that replaces the chunk objects.

- The remux is a **server-side job**, not a step in the WebSocket finalize path. Finalize stays
  what it is: write the manifest, enqueue, acknowledge.
- The job is **enqueued by the transcription job on success**, not at finalize. That is the one
  ordering that removes the race entirely: the transcription worker is the only other reader of the
  chunk objects, and when it has finished with them nothing else is holding them. A recording whose
  transcription has failed keeps its chunks and keeps playing the way it does today, which is the
  same fallback the failure path already relies on.
- The job writes the seekable object under the session prefix, **verifies it before anything is
  deleted** — the Cues element and a Duration are present, the declared duration matches the
  transcript's, and the object reads back at its written length — then updates the manifest to name
  it, and only then deletes the chunk objects. The second copy exists for the length of one job and
  never becomes durable.
- Both readers resolve the audio **through the manifest**: the named object when there is one,
  the concatenated chunks otherwise. Playback keeps the offset arithmetic it has; with a single
  object it degenerates to a single slice.
- The remux is **lossless repackaging only** — stream copy, never a re-encode. Machine output stays
  immutable in the sense ADR-003 means it: the audio is bit-identical, only the container's
  bookkeeping is rewritten.
- **Reattach must refuse a session that has a manifest.** Today `attach` rebuilds `persistedSeq`
  from a chunk listing, and an empty listing yields `-1`. Once chunks can legitimately be gone, a
  late reconnect to a finalized session would look like a recording that never stored anything and
  would invite the client to re-send from zero. The manifest is the marker that the recording is
  closed, and attaching to a closed session is an error, not a resume.

Only the container is in scope here. Switching the client from the whole-file blob to a streaming
`<audio>` source needs a short-lived scoped playback token, because a media element cannot carry an
`Authorization` header and a presigned storage URL is ruled out by ADR-001. That is a separate
decision; this one is its precondition.

## Consequences

- Playback gets a real timeline: a duration without waiting for the transcript, and a seek that
  costs one ranged read instead of the whole recording.
- Storage goes down slightly, and the object count per recording drops from thousands to a handful,
  which makes listing, quota measurement and the deletion cascade cheaper.
- The deletion cascade is unchanged. It works from a prefix listing rather than from the manifest,
  so it removes the remuxed object for the same reason it removes chunks no manifest mentions.
- Crash recovery is unchanged. Remuxing only ever runs after a recording is finalized and
  transcribed, and a finalized recording is not resumable — the reattach rule above makes that
  explicit instead of leaving it to the fact that chunks happen to still exist.
- A recording exists in two shapes for a while: chunk objects until the pipeline has been through
  it, one object afterwards. Both readers must handle both, and the E2E coverage of the core path
  and of deletion has to assert both shapes rather than only the one it happens to catch.
- The pipeline depends on a remuxing tool. Stream-copy WebM remuxing is a small, well-specified
  operation and a dedicated EBML pass in the worker is a plausible alternative to a binary
  dependency; which of the two to build is an implementation question, not a decision this ADR
  needs to make.
- Recordings finalized before this lands keep their chunk objects and keep playing. Whether they
  are converted by a backfill or simply left alone is a follow-up question, not part of this
  decision.
