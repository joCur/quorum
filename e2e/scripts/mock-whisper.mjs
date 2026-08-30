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

/** Fixed response in the `verbose_json` shape, with the word timestamps ADR-003 requires. */
function transcription() {
  return {
    task: "transcribe",
    language: "en",
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
  return { sections };
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
    // The body is drained but not inspected: this endpoint stands in for a model, not for a
    // decoder, and the audio itself is asserted on in object storage instead.
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(transcription()));
    });
    return;
  }
  if (request.url === "/health" || request.url === "/v1/models") {
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
