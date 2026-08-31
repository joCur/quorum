# Quorum — Roadmap

> Expanded into GitHub issues/milestones at project start.

## V1 — Walking Skeleton up to the Demo

1. Auth (OIDC, off-the-shelf solution, Authorization Code + PKCE) + tenant/user scope in every data object
2. WebSocket recording endpoint per the protocol (ADR-002), persistence in object storage, `chunk.ack`
3. Web client: recording (getUserMedia + MediaRecorder), wake lock, IndexedDB buffer, reconnect from `persistedSeq`
4. Job worker: Whisper transcription → transcript schema (including word timestamps)
5. Summary worker: system template → OpenAI-compatible API → summary with a template snapshot
6. Meeting management: list, listen back, transcript view, complete deletion (cascade)
7. User templates (basedOn + overrides)
8. E2E tests of the critical paths: recording→transcript→summary, auth flows, deletion

## V2 — Build-Out

- Transcript corrections in the UI (editedText/editedSpeakerId, the original is retained)
- Reprocessing feature (a new model over old audio, 1:n transcripts)
- Live transcript (enable `transcript.partial`)
- Retention rules per user (automatic deletion of audio)
- Quotas/limits per plan

## Later / After a Compliance Review

- Speaker diarization
- Speaker profiles for re-identification (biometric data, Art. 9 GDPR — a deliberate compliance decision)
- A local processing path (in-browser Whisper) as a third user option
- Self-hosted summary LLMs (a configuration change thanks to the OpenAI-compatible abstraction, ADR-005)
- PII redaction as an overlay
- Team/org scope for templates
