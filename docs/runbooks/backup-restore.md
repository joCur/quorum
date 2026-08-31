# Runbook — backup and restore

A concept and a procedure, not automation. Nothing in this repository runs a backup: the schedule,
the destination and the credentials for it are deployment decisions, and a backup script committed
here would be one that nobody has ever restored from. What is written down instead is what has to
be backed up, how often, how to restore it, and the two obligations that are easy to get wrong —
the encryption key, and removing deleted meetings from the backups.

Scope: PostgreSQL (meetings, transcripts, summaries, jobs, templates, and Keycloak's own database)
and MinIO (recorded audio). Related: [`pipeline.md`](pipeline.md) for pipeline incidents.

## What has to be backed up

| What                        | Where it lives                        | Losing it means                                        |
| --------------------------- | ------------------------------------- | ------------------------------------------------------ |
| PostgreSQL `quorum` database | `pg-data` volume                      | Every meeting, transcript, summary and template is gone |
| PostgreSQL `keycloak` database | same volume, separate logical database | Users and realm configuration are gone                 |
| MinIO bucket                | `minio-data` volume                   | Every recording is gone                                 |
| **`MINIO_KMS_SECRET_KEY`**  | the deployment's environment          | **Every backed-up recording is unreadable ciphertext**  |

The last row is the one that turns a good backup into a useless one. See
[the KMS master key](#the-kms-master-key) below.

Not backed up on purpose: Prometheus and Grafana volumes. Operational metrics are worth 15 days of
retention and nothing more; the dashboards and rules are in `infra/monitoring/`.

**Nothing here reads a volume directory, and that is deliberate.** The "where it lives" column
names Docker volumes so you know what would be lost, not what to copy. Both procedures below go
through a running service — `pg_dump` per logical database, `mc mirror` against the MinIO API —
because copying a live Postgres data directory produces a file that looks like a backup and
restores as a corrupt database. The practical consequence is a good one: whether those volumes are
named Docker volumes or bound to a host path changes nothing about backing them up, so a
deployment can relocate its data onto a specific filesystem without any of this needing to change.
The deployment guide describes how.

## Schedule

The proposal for the single-host phase, to be adjusted when there are real users:

| What              | Frequency          | Retention | Rationale                                                       |
| ----------------- | ------------------ | --------- | --------------------------------------------------------------- |
| PostgreSQL dump   | daily              | 30 days   | Recovery point of one day; a schema-level accident is usually noticed within days |
| MinIO bucket sync | daily, incremental | 30 days   | Audio is immutable once written, so a sync is cheap after the first run |
| Key material      | on change only     | forever, offline | It changes almost never and must outlive every backup that depends on it |

Retention is **30 days across the board**, and that number is not arbitrary — it is the deletion
window (below). A longer retention would mean a deleted meeting survives longer in the backups.

The two data backups should run at the same time, or with the database dump *after* the object
sync. A recording present in the database but missing from object storage looks to the pipeline
like a job whose audio has vanished; the opposite is a harmless orphan object.

## Tooling recommendation

**PostgreSQL: `pg_dump` per database, not a volume snapshot.**

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > quorum-$(date +%F).dump
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc keycloak    > keycloak-$(date +%F).dump
```

Custom format (`-Fc`) because it restores selectively and compresses. A logical dump survives a
PostgreSQL major-version upgrade; a copy of the data directory does not, and a filesystem snapshot
of a running database is not consistent unless the filesystem can do atomic snapshots.

For a deployment that needs a recovery point measured in minutes rather than a day, the answer is
continuous archiving — [pgBackRest](https://pgbackrest.org/) is the mature choice. That is worth
setting up when losing a day of meetings becomes unacceptable, not before.

**MinIO: `mc mirror` to an external target.**

```bash
mc alias set backup https://<offsite-endpoint> <access-key> <secret-key>
mc mirror --overwrite --remove quorum/"$S3_BUCKET" backup/quorum-audio
```

`--remove` is what makes the mirror reflect deletions — see the deletion window below. Without it
the mirror grows forever and every deleted recording lives on in it.

Objects are encrypted server-side, so they leave MinIO as ciphertext and the backup target never
sees plaintext audio. That is the property that makes an off-site copy acceptable, and it is also
exactly why the key backup matters.

**Destination:** somewhere that is not this host and not this provider. A backup on the same disk
protects against nothing that actually happens.

**Verify restores on a schedule.** A backup nobody has restored is a hypothesis. Restoring into a
throwaway compose project once a quarter — the procedure below, with a different project name — is
the whole test.

## Restore

**1. Bring up an empty stack** with the same `MINIO_KMS_SECRET_KEY` as the backup was taken with.
Wrong key, unreadable audio; the preflight check cannot detect this, because a well-formed wrong
key looks exactly like the right one.

```bash
docker compose up -d postgres minio minio-init
```

**2. Restore the databases.**

```bash
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < quorum-YYYY-MM-DD.dump
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d keycloak       --clean --if-exists < keycloak-YYYY-MM-DD.dump
```

**3. Restore the objects.**

```bash
mc mirror --overwrite backup/quorum-audio quorum/"$S3_BUCKET"
```

**4. Start the rest and check.**

```bash
docker compose up -d
curl http://localhost:8080/healthz
```

Then confirm the data actually reads end to end: open a meeting in the app and play its audio.
Playback is the check that proves the KMS key matches — the meeting list renders fine from the
database alone, so a list full of meetings tells you nothing about the audio.

**5. Expect the queue to move.** pg-boss jobs are restored with the database, so jobs that were
queued when the dump was taken run again. That is safe — every job is idempotent
([`pipeline.md`](pipeline.md#idempotency--which-jobs-are-safe-to-replay)) — but on a large restore
it means a burst of transcription work. Stop the worker first if the timing is inconvenient.

## The deletion window

ADR-001 promises that deleting a meeting cascades to its audio, transcripts, summaries and derived
data, **including removal from backups after a defined window**. This proposes that window.

**The window is 30 days.** A deleted meeting disappears from live storage immediately and from
every backup within 30 days.

The reasoning: the window cannot be zero, because a backup that rewrote itself whenever something
was deleted would not be a backup — an accidental deletion could then never be undone, and
protecting against exactly that is what backups are for. So the window is the shortest period that
still leaves room to notice and reverse a mistake, and 30 days is the conventional answer to that
in every retention policy this project would be measured against.

**How it is enforced:** by retention, not by editing backups.

- Backups older than 30 days are deleted, wholesale. Nothing ever reaches inside a backup to remove
  one meeting from it.
- Every backup taken after the deletion no longer contains the meeting: the database dump is taken
  from live data, and the object mirror runs with `--remove`.
- Therefore, 30 days after a deletion, no surviving backup contains it.

**What this requires of whoever operates the deployment:**

1. Retention must actually delete. A backup target with no lifecycle rule silently converts the
   window into "forever", and the deletion promise quietly becomes false.
2. The object mirror must run with `--remove`. Without it, deleted objects persist in the mirror
   regardless of retention.
3. The window and the retention are the same number. Raising retention to 90 days raises the
   deletion window to 90 days, and that has to be a deliberate, documented choice — not a side
   effect of wanting longer recovery.

The number belongs in whatever the deployment tells its users about deletion. It is a promise, not
an implementation detail.

## The KMS master key

`MINIO_KMS_SECRET_KEY` is the key MinIO's built-in KMS uses for default bucket encryption
(ADR-001). Format: `<key-name>:<base64 of exactly 32 bytes>`.

It is a single point of failure twice over, in opposite directions:

1. **Lose it and every recording is gone**, live and backed up alike. The ciphertext is intact and
   worthless. No support path, no recovery — this is what encryption at rest means.
2. **Malform it and the whole stack refuses to start**, historically behind an error message that
   never named the variable. The `kms-preflight` service now catches that case before MinIO gets
   the chance, and says exactly what is wrong.

What preflight cannot catch is a **well-formed wrong key**: it validates the shape, not the
identity. Nothing at startup can, which is why the procedure below is the actual protection.

### Backing it up

1. **Store it where the data backups are not.** A key sitting next to the ciphertext it decrypts is
   not protection. A password manager, a sealed envelope, an offline encrypted volume — anywhere
   that survives the loss of both the host and the backup target.
2. **Keep at least two copies**, in different places, held by different people. Access to
   recordings should not depend on one person or one laptop.
3. **Record the key name, not only the secret.** The name is part of the value and a restore that
   gets it wrong fails the same way a wrong secret does.
4. **Note which deployment and which date range it belongs to.** If the key is ever rotated, an
   old backup needs the key that was current when it was taken — a label is the difference between
   a restore and a guess.
5. **Verify the copy before it is needed.** During a restore rehearsal, use the stored copy rather
   than the one in the running environment. That is the only thing that proves it is correct.

### Rotating it

There is no in-place rotation with the built-in static-key KMS. Changing
`MINIO_KMS_SECRET_KEY` on a stack that already holds recordings makes the existing audio
unreadable — the old key is not consulted for old objects. A rotation therefore means:

1. Keep the old key. Do not remove it from anywhere until this is finished and verified.
2. Stand up storage with the new key.
3. Copy every object through a client that decrypts with the old key and writes with the new one.
4. Verify by playing back audio from several meetings across the whole date range.
5. Keep the old key for as long as any backup taken under it is still within retention — 30 days.
   Only then destroy it.

If key rotation becomes a regular requirement, the answer is not this procedure but a real key
management service: MinIO supports SSE-KMS via [KES](https://github.com/minio/kes), which keeps
per-object data keys wrapped by a master key that can be rotated without rewriting objects. That is
a deliberate infrastructure change, not something to reach for during an incident.
