# Quorum — Cost Model per Meeting Hour

As of 2026-08 · the basis for the pitch and for later plan prices/quotas.

## Option A: Our Own Server (early phase, Docker Compose)

| Item | per meeting hour |
|---|---|
| Electricity for Whisper transcription (GPU, roughly 0.15–0.2 kWh) | ~€0.05–0.08 |
| Summary via OpenRouter (12–15k input / 1–2k output tokens) | ~€0.01–0.05 |
| Storage (Opus ~15 MB/h, local) | ~€0 |
| **Marginal cost** | **~€0.10** |

No fixed costs beyond the hardware we already have. A GTX 1050 means small-model quality
(development); after the upgrade to a 4070 Ti Super, large-v3 quality at an estimated
~12–18x real time, with existing meetings improvable retroactively via reprocessing (ADR-003).

## Option B: Cloud (Hetzner, once there is real load)

Reference: GEX44 (RTX 4000 SFF Ada, 20 GB) ≈ €232/month net, i.e. ~€0.37 per GPU hour;
object storage ~€6.50/month for 1 TB (≈ 65,000 meeting hours of audio).

| Item | per meeting hour |
|---|---|
| Transcription (large-v3, a conservative 6x real time → 10 min of GPU) | ~€0.06 |
| Summary (OpenRouter, standard model) | ~€0.01–0.05 |
| Storage (ongoing) | ~€0.0001/month |
| **Marginal cost** | **~€0.10** |

**The fixed-cost reality:** the marginal costs hold with the GPU fully utilized. At, say, 200
meeting hours/month the effective cost is ~€1.20/h (the GPU fixed cost spread out). Relief:
hourly billing with no minimum term (GPU only on demand, the queue buffers) or CPU
transcription in the early phase.

## Enforcement of the input-token assumption

The 12–15k input tokens per meeting hour above are not a hope: the summary worker
enforces them. `SUMMARY_MAX_INPUT_TOKENS` (default 14,000) caps the transcript
handed to the model, and a longer recording keeps its head and its tail while the
middle is elided on segment boundaries behind a visible marker. A four-hour
workshop therefore costs what a one-hour meeting costs, instead of quadrupling the
bill or failing on context length after the tokens were already paid for.

The trade-off is deliberate and documented in `worker/README.md`: long meetings
lose detail from their middle. Full fidelity for those means map-reduce over
windows, which is a later ticket rather than a bigger prompt.

Actual `promptTokens` / `completionTokens` are logged per summary job wherever the
backend reports them, so these estimates can eventually be replaced by
measurements.

## The Pitch Statement

Marginal cost ~€0.10 per meeting hour; fixed costs €0 (our own server) up to
~€230/month (a dedicated cloud GPU). From a few hundred meeting hours per month
onward, every realistic subscription model is clearly profitable.

## To Do After the Hardware Test

Measure the 4070 Ti Super for real: run whisperX including word alignment (what ADR-003
asks for) and VAD, note VRAM and the actual throughput time → replace the numbers here.
