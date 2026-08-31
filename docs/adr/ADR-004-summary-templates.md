# ADR-004: Summary Templates with Inheritance and a Snapshot

**Status:** Accepted · **Date:** 2026-08-29

## Decision

1. **Templates with one level of inheritance:** a system template as the general default; user templates via `basedOn` with section overrides (add/override/hide). Scope: `system | user`, extensible later with `team/org`.
2. **A snapshot instead of a reference:** a generated summary stores the resolved template configuration plus the model and prompt version as a copy — later template changes do not falsify the history.
3. **1:n:** a meeting can have several summaries (different templates, regeneration); one active per template.
4. **Source references:** `sourceSegmentIds` per summary section (nullable, unpopulated in V1) — uses the stable segment IDs from ADR-003.
5. **Structured output:** a summary is JSON (sections with content), not a Markdown blob. A Markdown export is trivial to derive; the other direction is not.
