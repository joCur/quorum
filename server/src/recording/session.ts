import { randomUUID } from "node:crypto";
import {
  ClientMessageSchema,
  type ClientMessage,
  type LimitErrorCode,
  type ServerMessage,
} from "@quorum/shared";
import {
  MAX_CHUNK_PAYLOAD_BYTES,
  checkAudioFormat,
  matchesContainer,
  type SupportedFormat,
} from "./audio-format.js";
import { parseChunkFrame } from "./frame.js";
import { chunkKey } from "./keys.js";
import {
  DEFAULT_USER_LIMITS,
  StaticUserLimitsResolver,
  monthStart,
  type UserLimits,
  type UserLimitsResolver,
} from "../limits.js";
import { ConnectionRateMeter, type SessionRegistry } from "./limits.js";
import type {
  JobQueue,
  MeetingRegistry,
  RecordingContext,
  RecordingStorage,
  SessionRecord,
} from "./types.js";

/**
 * Close codes used by the recording endpoint. The protocol schema
 * (`recording-protocol.ts`) intentionally has no error message type, so failures
 * are reported through the WebSocket close frame.
 */
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_MESSAGE_TOO_BIG = 1009;
export const CLOSE_INTERNAL_ERROR = 1011;
export const CLOSE_NORMAL = 1000;

/**
 * How far ahead of `persistedSeq` a client may run. Chunks are 1–2 s of audio
 * (ADR-002), so this is minutes of head room while still bounding the amount of
 * out-of-order state a single connection can force the server to hold.
 */
export const MAX_SEQ_GAP = 1024;

/**
 * Whether a session is paused, and since when, read back from its persisted marks.
 *
 * The marks are the only record of a pause that survives the connection that heard about it, so
 * this is what makes the pause limit hold across a reconnect: a client that pauses, disappears and
 * comes back three hours later is judged by when it paused.
 */
function pausedSinceFromMarks(marks: SessionRecord["marks"]): number | null {
  const last = marks.at(-1);
  if (!last || last.type !== "pause") return null;
  const at = Date.parse(last.at);
  return Number.isNaN(at) ? null : at;
}

/** Timer that never keeps the process alive on its own, used when no scheduler is injected. */
function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return () => clearTimeout(handle);
}

export interface Connection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface SessionDeps {
  storage: RecordingStorage;
  queue: JobQueue;
  /**
   * Tenant/user scope. May be supplied later via `setContext` when it is
   * resolved asynchronously during the WebSocket upgrade.
   */
  context?: RecordingContext | undefined;
  /**
   * Index that makes the recording appear in the meeting list. Optional: an instance without one
   * still records, it just produces nothing to list.
   */
  meetings?: MeetingRegistry | undefined;
  /**
   * Where the abuse and cost limits of the acting user come from. Defaults to the static resolver
   * over `DEFAULT_USER_LIMITS`, so an instance that passes nothing is protected rather than
   * unprotected.
   */
  limits?: UserLimitsResolver | undefined;
  /**
   * Shared across every connection of one server process; this is what makes the parallel-session
   * cap mean anything. Without it the cap is not enforced.
   */
  registry?: SessionRegistry | undefined;
  now?: () => Date;
  /**
   * Runs `callback` after `delayMs`, returning a function that cancels it.
   *
   * A paused session sends nothing, so the pause limit is the one limit that cannot be checked
   * when a frame arrives — it needs a timer. Injected so tests drive it by hand instead of
   * waiting, and `unref`ed by default so a pending pause deadline never keeps the process alive.
   */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  newId?: () => string;
  logger?: SessionLogger | undefined;
}

/**
 * The slice of a pino logger this handler uses.
 *
 * `child` is optional so a test can pass a two-method stub, but in production it
 * is what puts `sessionId` and `meetingId` on every line a connection emits —
 * the meeting↔session↔job correlation the rest of the observability work builds
 * on. Without it a failed recording logs a reason and no way to tell whose
 * recording failed.
 */
export interface SessionLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  child?(bindings: Record<string, unknown>): SessionLogger;
}

interface ActiveSession {
  record: SessionRecord;
  format: SupportedFormat;
  /** Highest sequence number for which all of 0..n are persisted, or -1. */
  persistedSeq: number;
  /** Sequence numbers persisted ahead of `persistedSeq` (out-of-order arrivals). */
  ahead: Set<number>;
  finalized: boolean;
  /** Bytes this connection has persisted for the session — what the storage quota counts. */
  audioBytes: number;
  /** Highest audio-time offset seen, i.e. recorded seconds excluding pauses. */
  recordedSeconds: number;
  /**
   * Wall-clock milliseconds at which the current pause began, or `null` while capture is running.
   *
   * Taken from the `at` of the pause mark, so a reconnecting client is judged by when it actually
   * paused rather than by when this connection heard about it.
   */
  pausedSince: number | null;
  /** Chunks persisted since usage was last written to the meeting index. */
  chunksSinceUsageFlush: number;
}

/**
 * Protocol state machine for a single WebSocket connection. Kept free of any
 * Fastify or `ws` types so it can be exercised directly in unit tests with a
 * fake storage adapter.
 */
export class RecordingSessionHandler {
  private readonly deps: SessionDeps;
  private readonly connection: Connection;
  private session: ActiveSession | null = null;
  private context: RecordingContext | null;
  /** Rebound to a session-scoped child as soon as there is a session to name. */
  private log: SessionLogger | undefined;
  private readonly limitsResolver: UserLimitsResolver;
  /**
   * Limits of the acting user, resolved once the session is known and then fixed for its whole
   * life — a limit must not change under a running recording.
   */
  private limits: UserLimits = DEFAULT_USER_LIMITS;
  /** Exists only once the limits are resolved, which is before the first chunk can arrive. */
  private rateMeter: ConnectionRateMeter | null = null;
  /** Scope and session this connection holds a slot for, so it can be released exactly once. */
  private registered: { scope: RecordingContext; sessionId: string } | null = null;
  /** Cancels the armed pause deadline, or `null` when the session is not paused. */
  private cancelPauseDeadline: (() => void) | null = null;

  constructor(connection: Connection, deps: SessionDeps) {
    this.connection = connection;
    this.deps = deps;
    this.context = deps.context ?? null;
    this.log = deps.logger;
    this.limitsResolver = deps.limits ?? new StaticUserLimitsResolver();
  }

  /**
   * Looks up the limits of the acting user and arms the connection's rate meter with them.
   *
   * Every enforcement site in this class reads `this.limits`; none of them knows where a number
   * came from. Plan tiers are then a different resolver, not a change here.
   */
  private async resolveLimits(context: RecordingContext): Promise<void> {
    this.limits = await this.limitsResolver.resolve(context);
    this.rateMeter = new ConnectionRateMeter(this.limits, () =>
      (this.deps.now?.() ?? new Date()).getTime(),
    );
  }

  /** Binds session and meeting id onto every subsequent line from this connection. */
  private bindSessionLog(record: SessionRecord): void {
    const base = this.deps.logger;
    this.log = base?.child?.({ sessionId: record.sessionId, meetingId: record.meetingId }) ?? base;
  }

  /** Supplies the tenant/user scope once authentication has resolved it. */
  setContext(context: RecordingContext): void {
    this.context = context;
  }

  private requireContext(): RecordingContext | null {
    if (!this.context) {
      this.connection.close(CLOSE_POLICY_VIOLATION, "unauthenticated connection");
      return null;
    }
    return this.context;
  }

  /** Current last persisted sequence number, or -1 when nothing is persisted. */
  get persistedSeq(): number {
    return this.session?.persistedSeq ?? -1;
  }

  get sessionId(): string | null {
    return this.session?.record.sessionId ?? null;
  }

  async handleText(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "control message is not valid JSON");
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.connection.close(
        CLOSE_PROTOCOL_ERROR,
        "control message does not match the protocol schema",
      );
      return;
    }
    await this.dispatch(parsed.data);
  }

  private async dispatch(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "session.start":
        await this.onStart(message);
        return;
      case "session.pause":
      case "session.resume":
        await this.onMark(
          message.type === "session.pause" ? "pause" : "resume",
          message.sessionId,
          message.at,
        );
        return;
      case "session.end":
        await this.onEnd(message.sessionId, message.lastSeq);
        return;
    }
  }

  private async onStart(message: Extract<ClientMessage, { type: "session.start" }>): Promise<void> {
    if (this.session) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "a session is already active on this connection");
      return;
    }
    const context = this.requireContext();
    if (!context) return;
    await this.resolveLimits(context);
    const check = checkAudioFormat(message.audioFormat);
    if (!check.ok) {
      this.connection.close(CLOSE_POLICY_VIOLATION, `rejected audio format: ${check.reason}`);
      return;
    }
    if (!(await this.withinQuota(context))) return;
    const newId = this.deps.newId ?? randomUUID;
    const record: SessionRecord = {
      sessionId: newId(),
      meetingId: newId(),
      tenantId: context.tenantId,
      userId: context.userId,
      meetingTitle: message.meetingTitle,
      summaryTemplateId: message.summaryTemplateId,
      audioFormat: message.audioFormat,
      createdAt: this.timestamp(),
      marks: [],
      recordedSeconds: 0,
    };
    if (!this.claimSessionSlot(context, record.sessionId)) return;
    try {
      await this.deps.storage.putSession(record);
    } catch (error) {
      this.fail("failed to persist session metadata", error);
      return;
    }
    this.bindSessionLog(record);
    await this.indexMeeting(record);
    this.session = {
      record,
      format: check.format,
      persistedSeq: -1,
      ahead: new Set(),
      finalized: false,
      audioBytes: 0,
      recordedSeconds: 0,
      pausedSince: null,
      chunksSinceUsageFlush: 0,
    };
    this.log?.info(
      { event: "session.started", container: record.audioFormat.container },
      "recording session started",
    );
    this.connection.send({ type: "session.ready", sessionId: record.sessionId });
  }

  /**
   * Storage and monthly recording quotas, checked once when a session starts.
   *
   * Checked at the start rather than continuously: the numbers come from the meetings the user
   * already has, and a session that is already running is bounded by the maximum session duration
   * anyway. The worst overshoot is therefore one full-length session per open connection, which
   * the parallel-session cap bounds in turn — a known, small amount, in exchange for not putting
   * a database query on the chunk path.
   *
   * A failure to read the usage lets the recording through. Recording is the one thing this
   * product must not lose, the other limits still apply, and the alternative is that a database
   * hiccup stops everybody from recording.
   */
  private async withinQuota(context: RecordingContext): Promise<boolean> {
    const readUsage = this.deps.meetings?.readUsage;
    if (!readUsage || !this.deps.meetings) return true;
    let usage;
    try {
      usage = await readUsage.call(
        this.deps.meetings,
        context,
        monthStart(this.deps.now?.() ?? new Date()),
      );
    } catch (error) {
      this.log?.warn(
        { event: "quota.read_failed", err: error },
        "failed to read the recording quota usage; letting the session start",
      );
      return true;
    }
    if (usage.storageBytes >= this.limits.maxStorageBytes) {
      this.closeWithLimit("limit.storage_quota_exceeded");
      return false;
    }
    if (usage.monthRecordedSeconds >= this.limits.maxMonthlyRecordedSeconds) {
      this.closeWithLimit("limit.monthly_hours_quota_exceeded");
      return false;
    }
    return true;
  }

  /**
   * Writes the session record back to storage, keeping the assertion recoverable.
   *
   * Best-effort on purpose: the record is metadata about a recording whose audio is already
   * safe, so a failed write costs at most the precision of the assertion after a reconnect —
   * never a chunk, and never the session. The chunk path must not die on it.
   */
  private async persistSessionRecord(session: ActiveSession): Promise<void> {
    try {
      await this.deps.storage.putSession(session.record);
    } catch (error) {
      this.log?.warn(
        { event: "session.metadata.write_failed", err: error },
        "failed to persist session metadata; a reconnect may assert less audio than was recorded",
      );
    }
  }

  /**
   * Raises the session's asserted audio time to a chunk's offset.
   *
   * Monotonic, and mirrored onto the session record so that every write of that record carries
   * the current value — which is what a reconnect reads back. The offset is the *start* of the
   * chunk, so the assertion trails the recording by one chunk; that is the direction to be wrong
   * in for a quota, and the exact length arrives with the transcript later anyway.
   */
  private countRecordedSeconds(session: ActiveSession, timestampOffset: number): void {
    if (!Number.isFinite(timestampOffset) || timestampOffset <= session.recordedSeconds) return;
    session.recordedSeconds = timestampOffset;
    session.record.recordedSeconds = timestampOffset;
  }

  /**
   * Writes what the session has consumed into the meeting index, and into the session record.
   *
   * Best-effort, like the rest of the indexing this handler does: a quota that could not be
   * updated must not cost the user their recording. Because the store keeps the larger of the two
   * values, a lost flush is repaired by the next one.
   *
   * The session record is written here too, on the same cadence, because it is what a reconnect
   * rebuilds the asserted duration from. Doing it per chunk would put an object write on the hot
   * path; doing it only at finalize would lose the assertion of every session whose connection
   * dies. A flush interval of it is the most a crash can cost.
   */
  private async flushUsage(session: ActiveSession): Promise<void> {
    session.chunksSinceUsageFlush = 0;
    await this.persistSessionRecord(session);
    const recordUsage = this.deps.meetings?.recordUsage;
    if (!recordUsage || !this.deps.meetings) return;
    try {
      await recordUsage.call(
        this.deps.meetings,
        { tenantId: session.record.tenantId, userId: session.record.userId },
        session.record.sessionId,
        { audioBytes: session.audioBytes, recordedSeconds: session.recordedSeconds },
      );
    } catch (error) {
      this.log?.warn(
        { event: "quota.usage_write_failed", err: error, sessionId: session.record.sessionId },
        "failed to record session usage; the quota may lag behind",
      );
    }
  }

  /**
   * Pause and resume carry wall-clock marks (ADR-002/ADR-003). A `session.resume`
   * for a session this connection does not know about is also the reconnect
   * path: session state is rebuilt from object storage — which is what lets a
   * client continue seamlessly after the server was killed mid-recording.
   *
   * The marks are also the pause bookkeeping: a pause arms the pause deadline and a resume
   * disarms it. Nothing about a pause is lost when the connection is replaced, because the marks
   * are persisted with the session record and read back on reattach.
   */
  private async onMark(type: "pause" | "resume", sessionId: string, at: string): Promise<void> {
    if (!this.session || this.session.record.sessionId !== sessionId) {
      if (type !== "resume") {
        this.connection.close(CLOSE_PROTOCOL_ERROR, "unknown session for this connection");
        return;
      }
      const attached = await this.attach(sessionId);
      if (!attached) return;
    }
    const session = this.session as ActiveSession;
    // A resume that arrives after the pause allowance ran out does not revive the session: it is
    // finalized here, exactly as the timer would have finalized it.
    if (await this.stopIfPastDeadline(session)) return;
    session.record.marks.push({ type, at });
    if (type === "pause") {
      this.beginPause(session, at);
    } else {
      this.endPause(session);
    }
    try {
      await this.deps.storage.putSession(session.record);
    } catch (error) {
      this.fail("failed to persist session metadata", error);
      return;
    }
    this.ack();
  }

  /**
   * Marks the session paused and arms the deadline that finalizes it if the pause never ends.
   *
   * The mark's own timestamp decides when the pause started, so the remaining allowance shrinks
   * rather than restarting when a client re-sends a pause it had already sent.
   */
  private beginPause(session: ActiveSession, at: string): void {
    const pausedAt = Date.parse(at);
    session.pausedSince = Number.isNaN(pausedAt) ? this.nowMs() : pausedAt;
    this.armPauseDeadline(session);
  }

  private endPause(session: ActiveSession): void {
    session.pausedSince = null;
    this.disarmPauseDeadline();
  }

  private armPauseDeadline(session: ActiveSession): void {
    this.disarmPauseDeadline();
    if (session.pausedSince === null) return;
    const remainingMs = Math.max(
      0,
      session.pausedSince + this.limits.maxPauseSeconds * 1000 - this.nowMs(),
    );
    const schedule = this.deps.schedule ?? defaultSchedule;
    this.cancelPauseDeadline = schedule(() => {
      void this.stopIfPastDeadline(session).catch(() => undefined);
    }, remainingMs);
  }

  private disarmPauseDeadline(): void {
    this.cancelPauseDeadline?.();
    this.cancelPauseDeadline = null;
  }

  /** Rebuilds session state from object storage after a reconnect. */
  private async attach(sessionId: string): Promise<boolean> {
    const context = this.requireContext();
    if (!context) return false;
    await this.resolveLimits(context);
    const { tenantId, userId } = context;
    let record: SessionRecord | null;
    try {
      record = await this.deps.storage.getSession(tenantId, userId, sessionId);
    } catch (error) {
      this.fail("failed to read session metadata", error);
      return false;
    }
    // Reading through the caller's tenant/user prefix is what enforces the scope:
    // another tenant simply cannot address this key.
    if (!record) {
      this.connection.close(CLOSE_POLICY_VIOLATION, "unknown session");
      return false;
    }
    const check = checkAudioFormat(record.audioFormat);
    if (!check.ok) {
      this.connection.close(CLOSE_POLICY_VIOLATION, `rejected audio format: ${check.reason}`);
      return false;
    }
    let seqs: number[];
    try {
      seqs = await this.deps.storage.listChunkSeqs(record);
    } catch (error) {
      this.fail("failed to list persisted chunks", error);
      return false;
    }
    if (!this.claimSessionSlot(context, record.sessionId)) return false;
    const session: ActiveSession = {
      record,
      format: check.format,
      persistedSeq: -1,
      ahead: new Set(seqs),
      finalized: false,
      // A reconnected connection counts its own bytes from zero; the store keeps the larger of
      // the two values, and the finalize replaces both with what storage actually holds.
      audioBytes: 0,
      // Audio time is not re-derivable from what storage holds — chunk lengths are the client's,
      // not the server's — so the session record carries it across the reconnect. Starting from
      // zero here would do more than weaken the limit: the manifest of a session finalized right
      // after a reattach would assert almost no audio, which reads downstream as a client that
      // understated a whole recording. The offsets of the chunks that arrive next raise it
      // further; they are absolute audio time, so the limit is fully back in force with the first
      // of them.
      recordedSeconds: record.recordedSeconds,
      pausedSince: pausedSinceFromMarks(record.marks),
      chunksSinceUsageFlush: 0,
    };
    this.session = session;
    // Bound before the deadline check, so a recording that is finalized on reconnect still logs
    // under its session and meeting id.
    this.bindSessionLog(record);
    // A recording that ran past the duration limit while it was disconnected must not be revived
    // by a reconnect; it is finalized here instead of continuing.
    if (await this.stopIfPastDeadline(session)) return false;
    this.advance(session);
    this.log?.info(
      { event: "session.reattached", persistedSeq: session.persistedSeq },
      "reattached to an existing session after a reconnect",
    );
    return true;
  }

  /**
   * Takes a slot in the per-user parallel-session cap, or refuses the session.
   *
   * A connection that already holds a slot for this session keeps it: `acquire` is keyed by
   * session id, so a reconnect for the user's own recording is never counted twice.
   */
  private claimSessionSlot(scope: RecordingContext, sessionId: string): boolean {
    const registry = this.deps.registry;
    if (!registry) return true;
    if (!registry.acquire(scope, sessionId, this.limits.maxParallelSessions)) {
      this.closeWithLimit("limit.parallel_sessions_exceeded");
      return false;
    }
    this.registered = { scope, sessionId };
    return true;
  }

  /**
   * Releases the parallel-session slot this connection holds. Called when the socket closes,
   * whatever the reason — a slot that leaked would lock a user out of recording.
   */
  dispose(): void {
    // Before the early return: a session that is paused when its socket dies has a deadline armed
    // whether or not it ever claimed a slot, and a timer that outlives its connection would
    // finalize into a connection nobody is listening on.
    this.disarmPauseDeadline();
    if (!this.registered) return;
    this.deps.registry?.release(this.registered.scope, this.registered.sessionId);
    this.registered = null;
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** Seconds of wall clock since the session started, pauses included. */
  private lifetimeSeconds(session: ActiveSession): number {
    const started = Date.parse(session.record.createdAt);
    if (Number.isNaN(started)) return 0;
    return Math.max(0, (this.nowMs() - started) / 1000);
  }

  /** Seconds the session has been paused for, or 0 while capture is running. */
  private pausedSeconds(session: ActiveSession): number {
    if (session.pausedSince === null) return 0;
    return Math.max(0, (this.nowMs() - session.pausedSince) / 1000);
  }

  /**
   * The three server-side hard stops on a recording, and what each of them protects.
   *
   * - Recorded audio (`maxRecordedSeconds`) is the cost limit, so it counts audio time and a
   *   pause spends none of it. Audio time is what the client puts in each chunk's offset; the
   *   wall-clock limits below are what bounds a client that lies about it.
   * - Session lifetime (`maxSessionLifetimeSeconds`) protects the open session itself — socket,
   *   state, session slot — and therefore counts wall clock, pauses included.
   * - Pause duration (`maxPauseSeconds`) closes a meeting whose break turned into an ending.
   *
   * All three finalize: the manifest is written and the transcription job enqueued, so the
   * recording survives as a valid, playable meeting and the user loses only what came after the
   * limit. None of them discards audio.
   *
   * Checked when a frame or a mark arrives rather than on a timer, because a session that sends
   * nothing costs nothing and every frame that would add cost is checked before it is accepted.
   * The one exception is the pause limit, which by definition applies while nothing is arriving:
   * a pause arms a deadline that runs this same check.
   */
  private async stopIfPastDeadline(session: ActiveSession): Promise<boolean> {
    const reason = this.exceededDeadline(session);
    if (!reason) return false;
    this.disarmPauseDeadline();
    if (!session.finalized) {
      const finalized = await this.finalize(session);
      if (!finalized) return true;
    }
    this.log?.info(
      {
        event: reason,
        recordedSeconds: session.recordedSeconds,
        lifetimeSeconds: this.lifetimeSeconds(session),
        pausedSeconds: this.pausedSeconds(session),
      },
      "recording reached a duration limit and was finalized",
    );
    this.connection.close(CLOSE_NORMAL, reason);
    return true;
  }

  /** Which duration limit the session is past, or `null` while it is within all of them. */
  private exceededDeadline(session: ActiveSession): LimitErrorCode | null {
    if (session.recordedSeconds > this.limits.maxRecordedSeconds) {
      return "limit.session_duration_exceeded";
    }
    if (this.pausedSeconds(session) > this.limits.maxPauseSeconds) {
      return "limit.pause_duration_exceeded";
    }
    if (this.lifetimeSeconds(session) > this.limits.maxSessionLifetimeSeconds) {
      return "limit.session_lifetime_exceeded";
    }
    return null;
  }

  /**
   * The single funnel for a limit refusal, which is why the log line lives here.
   *
   * Without it a refused recording is invisible on the server: the user sees a connection that
   * closes and the operator sees nothing at all. `info`, not `warn` — a limit doing its job is
   * normal operation, and the connection-scoped logger supplies the tenant and user behind it.
   */
  private closeWithLimit(code: LimitErrorCode): void {
    this.log?.info({ event: code }, "recording refused by a limit");
    this.connection.close(CLOSE_POLICY_VIOLATION, code);
  }

  async handleBinary(frame: Uint8Array): Promise<void> {
    const session = this.session;
    if (!session) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "chunk received before session.start");
      return;
    }
    // Metered before the frame is looked at, on its whole length: a frame costs bandwidth and a
    // storage round trip whether or not it turns out to be well formed or a duplicate. The meter
    // exists from the moment the session does, because that is when this user's limits are known.
    const exceeded = this.rateMeter?.admit(frame.byteLength) ?? null;
    if (exceeded !== null) {
      this.closeWithLimit(
        exceeded === "chunks" ? "limit.chunk_rate_exceeded" : "limit.byte_rate_exceeded",
      );
      return;
    }
    if (session.finalized) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "chunk received after session.end");
      return;
    }
    if (await this.stopIfPastDeadline(session)) return;
    const parsed = parseChunkFrame(frame);
    if (!parsed.ok) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, parsed.reason);
      return;
    }
    const { meta, payload } = parsed.chunk;
    if (meta.sessionId !== session.record.sessionId) {
      this.connection.close(
        CLOSE_POLICY_VIOLATION,
        "chunk session id does not match the active session",
      );
      return;
    }
    if (payload.length > MAX_CHUNK_PAYLOAD_BYTES) {
      this.connection.close(
        CLOSE_MESSAGE_TOO_BIG,
        "chunk payload exceeds the per-chunk size limit",
      );
      return;
    }
    // The first chunk of a recording carries the container header; later chunks
    // are continuation bytes of the same stream.
    if (meta.seq === 0 && !matchesContainer(session.format, payload)) {
      this.connection.close(
        CLOSE_POLICY_VIOLATION,
        `chunk does not match the announced "${session.record.audioFormat.container}" container`,
      );
      return;
    }
    if (meta.seq > session.persistedSeq + MAX_SEQ_GAP) {
      this.connection.close(
        CLOSE_POLICY_VIOLATION,
        "sequence number too far ahead of the last persisted chunk",
      );
      return;
    }
    // The offset is audio time, and it counts before anything else looks at the frame: a chunk
    // this connection has already seen is still evidence of how far the recording has come, and a
    // re-delivered one after a reconnect is exactly the case where the assertion has to catch up.
    // Deciding the limit here also means it is decided on the chunk that would cross it rather
    // than one chunk later. Everything already persisted still becomes a meeting.
    this.countRecordedSeconds(session, meta.timestampOffset);
    if (meta.timestampOffset > this.limits.maxRecordedSeconds) {
      if (await this.stopIfPastDeadline(session)) return;
    }
    // Duplicates are idempotent: a reconnecting client may re-send chunks it has
    // already had acknowledged.
    if (meta.seq <= session.persistedSeq || session.ahead.has(meta.seq)) {
      this.ack();
      return;
    }
    try {
      await this.deps.storage.putChunk(session.record, meta.seq, payload);
    } catch (error) {
      this.fail("failed to persist chunk", error);
      return;
    }
    // Only now — after a successful write — does the chunk count as persisted.
    session.ahead.add(meta.seq);
    session.audioBytes += payload.length;
    session.chunksSinceUsageFlush += 1;
    if (session.chunksSinceUsageFlush >= this.limits.usageFlushChunks) {
      await this.flushUsage(session);
    }
    this.advance(session);
  }

  /** Moves `persistedSeq` forward over the contiguous run of persisted chunks. */
  private advance(session: ActiveSession): void {
    while (session.ahead.has(session.persistedSeq + 1)) {
      session.persistedSeq += 1;
      session.ahead.delete(session.persistedSeq);
    }
    this.ack();
  }

  private async onEnd(sessionId: string, lastSeq: number): Promise<void> {
    const session = this.session;
    if (!session || session.record.sessionId !== sessionId) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "unknown session for this connection");
      return;
    }
    // Incomplete recording: do not finalize, re-acknowledge so the client
    // re-sends everything after `persistedSeq`.
    if (lastSeq > session.persistedSeq) {
      this.ack();
      return;
    }
    if (!(await this.finalize(session))) return;
    this.connection.close(CLOSE_NORMAL, "session finalized");
  }

  /**
   * Writes the manifest, enqueues transcription and answers `session.finalized`.
   *
   * Shared by the client's own `session.end` and by the server-side duration stop, so a recording
   * the server had to cut short goes through exactly the same path and ends up as exactly the same
   * kind of meeting. Returns `false` when the connection was closed with a failure instead.
   */
  private async finalize(session: ActiveSession): Promise<boolean> {
    const scope = {
      tenantId: session.record.tenantId,
      userId: session.record.userId,
      sessionId: session.record.sessionId,
    };
    const chunkKeys: string[] = [];
    for (let seq = 0; seq <= session.persistedSeq; seq += 1) {
      chunkKeys.push(chunkKey(scope, seq));
    }
    const newId = this.deps.newId ?? randomUUID;
    const jobId = newId();
    try {
      await this.deps.storage.putManifest(session.record, {
        sessionId: session.record.sessionId,
        meetingId: session.record.meetingId,
        tenantId: session.record.tenantId,
        userId: session.record.userId,
        audioFormat: session.record.audioFormat,
        chunkCount: session.persistedSeq + 1,
        persistedSeq: session.persistedSeq,
        chunkKeys,
        marks: session.record.marks,
        recordedSeconds: session.recordedSeconds,
        finalizedAt: this.timestamp(),
      });
      await this.deps.queue.enqueueTranscribe({
        jobId,
        meetingId: session.record.meetingId,
        tenantId: session.record.tenantId,
        userId: session.record.userId,
        sessionId: session.record.sessionId,
      });
    } catch (error) {
      this.fail("failed to finalize session", error);
      return false;
    }
    // The audio and the job are safe at this point, so indexing failures must not fail the
    // recording. `recordSession` runs again first: it is idempotent on the session id and
    // repairs a meeting whose row could not be written when the session started.
    await this.indexMeeting(session.record);
    await this.settleUsage(session);
    try {
      await this.deps.meetings?.markFinalized(
        { tenantId: session.record.tenantId, userId: session.record.userId },
        session.record.sessionId,
        this.timestamp(),
      );
    } catch (error) {
      this.log?.warn(
        { event: "meeting.finalize_index_failed", err: error },
        "failed to mark the meeting finalized in the meeting index",
      );
    }

    session.finalized = true;
    // The one line that ties a recording to the job id the pipeline is about to run under. A
    // stuck transcription is diagnosed by starting here and following `jobId` into the worker.
    this.log?.info(
      {
        event: "session.finalized",
        jobId,
        chunkCount: session.persistedSeq + 1,
      },
      "recording finalized and transcription job enqueued",
    );
    this.connection.send({
      type: "session.finalized",
      sessionId: session.record.sessionId,
      meetingId: session.record.meetingId,
      jobId,
    });
    return true;
  }

  /**
   * Final, authoritative usage for the session.
   *
   * The byte count is taken from a listing of what object storage actually holds rather than from
   * this connection's own counter, because a session that survived a reconnect was partly written
   * by a connection that is gone. One listing per finalized recording, on a path that already
   * costs a manifest write and an enqueue.
   */
  private async settleUsage(session: ActiveSession): Promise<void> {
    try {
      const objects = await this.deps.storage.listSessionObjects({
        tenantId: session.record.tenantId,
        userId: session.record.userId,
        sessionId: session.record.sessionId,
      });
      session.audioBytes = objects.reduce((total, object) => total + object.size, 0);
    } catch (error) {
      this.log?.warn(
        { event: "quota.usage_measure_failed", err: error, sessionId: session.record.sessionId },
        "failed to measure the stored audio; the usage estimate of this connection is used",
      );
    }
    await this.flushUsage(session);
  }

  /**
   * Writes the meeting into the list index.
   *
   * Best-effort on purpose: capture integrity outranks listability. If the index write fails, the
   * audio is still being persisted and the recording continues; `session.end` retries the same
   * idempotent write, so a transient database blip during `session.start` heals on its own.
   */
  private async indexMeeting(record: SessionRecord): Promise<void> {
    try {
      await this.deps.meetings?.recordSession({
        meetingId: record.meetingId,
        sessionId: record.sessionId,
        tenantId: record.tenantId,
        userId: record.userId,
        title: record.meetingTitle,
        audioFormat: record.audioFormat,
        createdAt: record.createdAt,
      });
    } catch (error) {
      this.log?.warn(
        { event: "meeting.index_failed", err: error, sessionId: record.sessionId },
        "failed to index the meeting; the recording continues",
      );
    }
  }

  private ack(): void {
    const session = this.session;
    if (!session || session.persistedSeq < 0) return;
    this.connection.send({
      type: "chunk.ack",
      sessionId: session.record.sessionId,
      persistedSeq: session.persistedSeq,
    });
  }

  private fail(message: string, error: unknown): void {
    this.log?.warn({ event: "session.failed", err: error, sessionId: this.sessionId }, message);
    this.connection.close(CLOSE_INTERNAL_ERROR, message);
  }

  private timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
