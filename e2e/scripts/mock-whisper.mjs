// Stubs of the two OpenAI-compatible backends the worker talks to: transcription and chat
// completions for summaries.
//
// WHY IT EXISTS: the suite's default run has to stay under a few minutes on a CI runner without a
// GPU. Real CPU Whisper spends most of that budget downloading and loading a model to transcribe
// audio the test does not assert on — the fake microphone produces a tone, not speech. What the
// core-path test actually verifies is that the job reaches the worker and that a correctly scoped
// transcript row appears, and this endpoint exercises exactly that wiring.
//
// The real transcription backend is one environment variable away: `E2E_WHISPER=real` starts the
// CPU Whisper container and points the worker at it instead. The summary backend has no such
// variant — the stack ships no LLM, and ADR-005 makes the endpoint the only thing that varies.
// See e2e/README.md.
import { createServer } from "node:http";

const port = Number.parseInt(process.env.MOCK_WHISPER_PORT ?? "8123", 10);

/**
 * The model this stub claims to have on disk. It has to match the worker's `WHISPER_MODEL`,
 * because the worker verifies on startup that the configured model is installed and would
 * otherwise try to download it here.
 */
const MODEL_ID = process.env.MOCK_WHISPER_MODEL ?? "mock-tiny";

/**
 * Armed by a test through `POST /control/reject-transcription`, spent by the next transcription
 * request.
 *
 * A failed pipeline is a state the UI has to render, and the only honest way to reach it is to let
 * a real job fail. One shot rather than a mode, because the suite runs serially and the meeting
 * recorded right after arming is the one meant to fail — no test has to remember to switch a mode
 * back off.
 */
let rejectNextTranscription = false;

/**
 * The form fields of the most recent transcription request, read back by a test through
 * `GET /control/last-transcription`.
 *
 * Only the short scalar fields are kept, and only by name: the audio part is binary and large, and
 * nothing here is a multipart parser. That is enough for the one thing a test needs to know from
 * this side — that the worker asked the backend for the behavior it is configured for.
 */
let lastTranscriptionFields = null;

/** The meeting name the stub suggests; the suite asserts on it verbatim. */
const STUB_SUMMARY_TITLE = "Stub meeting about the release";

/** Field names worth recording — everything else in the body is the audio itself. */
const OBSERVED_FIELDS = ["model", "response_format", "language", "vad_filter", "prompt"];

/**
 * Pulls one simple form field out of a raw multipart body.
 *
 * Deliberately minimal: the parts the worker sends besides the file are single-line values, so the
 * header line plus the blank line plus one line of value is the whole grammar needed. Read as
 * latin1 so the binary audio part cannot produce replacement characters that shift offsets.
 */
function formField(body, name) {
  const match = new RegExp(
    `name="${name}"\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([^\\r\\n]{0,128})\\r\\n`,
  ).exec(body);
  return match ? match[1] : null;
}

function observedFields(body) {
  const text = body.toString("latin1");
  return Object.fromEntries(OBSERVED_FIELDS.map((name) => [name, formField(text, name)]));
}

/** The shape a real OpenAI-compatible backend answers with when it does not have the model. */
function rejection() {
  return {
    detail: `Model '${MODEL_ID}' is not installed locally. Install it or pick a model that is available.`,
  };
}

/**
 * Fixed response in the `verbose_json` shape, with the word timestamps ADR-003 requires.
 *
 * The language is echoed back from the request the way a real backend does: asked for one, it
 * reports that one; asked for none, it reports what it "detected". That is what lets a test hold
 * the pipeline to storing the language the transcription was actually made in.
 */
function transcription(fields) {
  return {
    task: "transcribe",
    language: fields?.language ?? "en",
    duration: 4,
    text: "This is a mock transcription produced by the end-to-end suite.",
    segments: [
      {
        id: 0,
        start: 0,
        end: 4,
        text: "This is a mock transcription produced by the end-to-end suite.",
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        words: [
          { word: "This", start: 0, end: 0.4 },
          { word: "is", start: 0.4, end: 0.6 },
          { word: "a", start: 0.6, end: 0.7 },
          { word: "mock", start: 0.7, end: 1.1 },
          { word: "transcription", start: 1.1, end: 2 },
          { word: "produced", start: 2, end: 2.5 },
          { word: "by", start: 2.5, end: 2.7 },
          { word: "the", start: 2.7, end: 2.9 },
          { word: "end-to-end", start: 2.9, end: 3.5 },
          { word: "suite.", start: 3.5, end: 4 },
        ],
      },
    ],
  };
}

/**
 * A summary answer built from the prompt itself.
 *
 * The prompt names each section as `sectionId: "<id>"` and its shape as `Format: "<format>"`, and
 * the mapping keeps only sections it asked for. Echoing the requested ids back is therefore the
 * one thing a stub has to get right for the pipeline to produce a stored summary.
 *
 * The envelope also carries the suggested meeting title, which is the one part of a summary that
 * leaves the summary: a recording nobody named takes it as its own name. A fixed string, so a
 * test can hold the meeting list to showing it.
 */
function summary(prompt) {
  const sections = [];
  const spec = /sectionId: "([^"]+)"[\s\S]*?Format: "(prose|bullets|table)"([^\n]*)/g;
  for (const [, sectionId, format, rest] of prompt.matchAll(spec)) {
    if (format === "prose") {
      sections.push({ sectionId, content: ["A stub summary produced by the end-to-end suite."] });
    } else if (format === "bullets") {
      sections.push({ sectionId, content: ["First stub point", "Second stub point"] });
    } else {
      const columns = [...rest.matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]);
      const row = Object.fromEntries(columns.map((column) => [column, "stub"]));
      sections.push({ sectionId, content: columns.length === 0 ? [] : [row] });
    }
  }
  return { title: STUB_SUMMARY_TITLE, sections };
}

/** The raw bytes of a request, for the multipart body the transcription endpoint receives. */
function readRawBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

const server = createServer((request, response) => {
  if (request.url === "/control/reject-transcription" && request.method === "POST") {
    request.resume();
    rejectNextTranscription = true;
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.url === "/control/last-transcription" && request.method === "GET") {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ fields: lastTranscriptionFields }));
    return;
  }

  if (request.url?.endsWith("/chat/completions") && request.method === "POST") {
    void readBody(request).then((body) => {
      // The prompt is read from the parsed messages, not from the raw body: inside JSON the
      // newlines the section spec is laid out with are escaped, and the patterns below are
      // line-oriented.
      const parsed = JSON.parse(body);
      const prompt = (parsed.messages ?? [])
        .map((message) => String(message.content ?? ""))
        .join("\n");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion",
          model: "mock-summary",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(summary(prompt)) },
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
    });
    return;
  }

  if (request.url?.endsWith("/audio/transcriptions") && request.method === "POST") {
    // The audio itself is not decoded — this endpoint stands in for a model, and object storage is
    // where the recording is asserted on. The body is read only to record which form fields came
    // with it, so a test can hold the worker to the request it is configured to send.
    void readRawBody(request).then((body) => {
      lastTranscriptionFields = observedFields(body);
      if (rejectNextTranscription) {
        // 404 is the answer the worker maps to a terminal rejection, so the job fails once
        // instead of being retried until a test runs out of patience.
        rejectNextTranscription = false;
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify(rejection()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(transcription(lastTranscriptionFields)));
    });
    return;
  }
  if (request.url === "/v1/models") {
    // The worker checks this listing on startup and installs the configured model when it is
    // missing, so the stub answers in the real shape and claims the model the run gives it.
    // Anything else would either send the worker into a download this endpoint cannot perform, or
    // hide the check behind its "backend has no model listing" fallback.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: MODEL_ID, object: "model", owned_by: "quorum-e2e" }],
      }),
    );
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[e2e] mock transcription and summary endpoints on http://127.0.0.1:${port}/v1`);
});
