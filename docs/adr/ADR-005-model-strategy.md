# ADR-005: Model Strategy — Self-Hosted Whisper + an OpenAI-Compatible API for Summaries

**Status:** Accepted · **Date:** 2026-08-29

## Context

Transcription and summarization are the two compute-intensive pipeline steps. The choice between self-hosting and external APIs determines operating costs and the privacy promise ("your data stays with us") at the same time.

## Decision

1. **Transcription: self-hosted Whisper.** Audio is the most sensitive artifact and does not leave our own infrastructure.
2. **Summaries: an OpenAI-compatible API as the abstraction.** The summary worker speaks exclusively the OpenAI-compatible chat completions format. We start with a hosted router (e.g. OpenRouter); moving to self-hosted models later (e.g. LM Studio, vLLM, Ollama) is a pure configuration change (base URL + model name), with no code change.
3. The model and prompt version are stored per transcript/summary (ADR-003/004) — which keeps a provider change traceable.

## Consequences

- For a transitional period, transcript text (not audio) leaves the infrastructure toward the summary API. That is a deliberate, documented limitation of the privacy promise until the LLMs are self-hosted — to be made transparent in the pitch and later in the terms of use.
- GPU capacity for Whisper becomes our own operational responsibility (sizing, queueing under load spikes → the job API/queue absorbs that conceptually).
