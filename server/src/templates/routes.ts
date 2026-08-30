import type { FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import {
  SummaryTemplateDraftSchema,
  SYSTEM_TEMPLATE_ID,
  TemplateResolutionError,
  resolveTemplateSections,
  type SummaryTemplate,
  type SummaryTemplateDraft,
  type SummaryTemplateList,
  type SummaryTemplateView,
} from "@quorum/shared";
import {
  TemplatesUnavailableError,
  templateFromDraft,
  type SummaryTemplateStore,
  type TemplateScope,
} from "./repository.js";

/** Stand-in id for the not-yet-stored template a create/update body is validated as. */
const VALIDATION_ID = "00000000-0000-4000-8000-000000000000";

export interface TemplateRoutesOptions {
  store: SummaryTemplateStore;
  /** Route prefix; the default matches the client's API base. */
  prefix?: string;
}

const TemplateParamsSchema = z.object({
  templateId: z.string().uuid(),
});

/**
 * CRUD for summary templates (ADR-004).
 *
 * SCOPING (ADR-001): the tenant and the user come from `request.requireContext()`, i.e. from the
 * validated access token, and are passed into every query as part of the predicate. A template id
 * belonging to another tenant or another user therefore matches no row and is answered with 404,
 * never 403 — a 403 would confirm that the id exists.
 *
 * The system template is the one exception that is visible without being owned: everybody reads
 * it, nobody edits it here. An edit aimed at it is answered with 404 as well, for the same
 * reason a template the caller does not own is: from the caller's side there is no such editable
 * template, and saying anything more precise would describe somebody else's data.
 */
const templateRoutesImpl: FastifyPluginAsync<TemplateRoutesOptions> = async (app, options) => {
  const prefix = options.prefix ?? "/api/summary-templates";
  const store = options.store;

  app.get(prefix, async (request) => {
    const scope = scopeOf(request.requireContext());
    const [templates, defaultTemplateId] = await Promise.all([
      store.listTemplates(scope),
      store.findDefaultTemplateId(scope),
    ]);
    const body: SummaryTemplateList = {
      templates: templates.map((template) => toView(template, templates, defaultTemplateId)),
    };
    return body;
  });

  app.get(`${prefix}/:templateId`, async (request, reply) => {
    const scope = scopeOf(request.requireContext());
    const params = TemplateParamsSchema.safeParse(request.params);
    // A malformed id cannot identify a template, and saying so would distinguish "not a template
    // id" from "not your template". Both are 404.
    if (!params.success) return reply.code(404).send(notFound());

    const template = await store.findTemplate(scope, params.data.templateId);
    if (!template) return reply.code(404).send(notFound());

    const base = await loadBase(store, scope, template);
    const defaultTemplateId = await store.findDefaultTemplateId(scope);
    const body: SummaryTemplateView = toView(template, base ? [base] : [], defaultTemplateId);
    return body;
  });

  app.post(prefix, async (request, reply) => {
    const scope = scopeOf(request.requireContext());
    const draft = await readDraft(store, scope, request.body, reply);
    if (!draft) return reply;

    try {
      const created = await store.createTemplate(scope, draft.draft);
      // A brand-new template is nobody's default yet; creating one is not a
      // decision to summarize with it from now on.
      const body: SummaryTemplateView = toView(created, draft.base ? [draft.base] : [], null);
      return reply.code(201).send(body);
    } catch (error) {
      return unavailable(error, reply);
    }
  });

  app.put(`${prefix}/:templateId`, async (request, reply) => {
    const scope = scopeOf(request.requireContext());
    const params = TemplateParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound());

    const draft = await readDraft(store, scope, request.body, reply);
    if (!draft) return reply;

    try {
      const updated = await store.updateTemplate(scope, params.data.templateId, draft.draft);
      if (!updated) return reply.code(404).send(notFound());
      const defaultTemplateId = await store.findDefaultTemplateId(scope);
      const body: SummaryTemplateView = toView(
        updated,
        draft.base ? [draft.base] : [],
        defaultTemplateId,
      );
      return body;
    } catch (error) {
      return unavailable(error, reply);
    }
  });

  /**
   * Deleting a template does not touch the summaries made with it: each carries a snapshot of
   * the configuration it was produced with (ADR-004 §2), so the history stays readable and
   * explicable after the template it came from is gone.
   */
  app.delete(`${prefix}/:templateId`, async (request, reply) => {
    const scope = scopeOf(request.requireContext());
    const params = TemplateParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound());

    const deleted = await store.deleteTemplate(scope, params.data.templateId);
    if (!deleted) return reply.code(404).send(notFound());
    return reply.code(204).send();
  });

  /**
   * Makes one of the caller's own templates the one new recordings are summarized with.
   *
   * PUT rather than POST because the choice is a single value being set to a state, and setting
   * it twice has to mean what setting it once means. Only a user template can be chosen: the
   * system template is what "no choice" already resolves to, so naming it here would be a second
   * way to express the same state.
   */
  app.put(`${prefix}/:templateId/default`, async (request, reply) => {
    const scope = scopeOf(request.requireContext());
    const params = TemplateParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound());

    try {
      const chosen = await store.setDefaultTemplate(scope, params.data.templateId);
      if (!chosen) return reply.code(404).send(notFound());
    } catch (error) {
      return unavailable(error, reply);
    }
    return reply.code(204).send();
  });

  /**
   * Gives up the choice, which puts the caller back on the system template.
   *
   * Unconditionally 204: a caller who has chosen nothing is already in the state this asks for,
   * and reporting that as a failure would make the control lie about what it did.
   */
  app.delete(`${prefix}/default`, async (request, reply) => {
    const scope = scopeOf(request.requireContext());
    await store.clearDefaultTemplate(scope);
    return reply.code(204).send();
  });
};

/**
 * Validates a create/update body and resolves the template it would inherit from.
 *
 * A draft is rejected here rather than at generation time, because a template that resolves to
 * nothing produces a summary with no sections — and the first time anyone would notice is after
 * a paid model call on a meeting they cared about.
 */
async function readDraft(
  store: SummaryTemplateStore,
  scope: TemplateScope,
  body: unknown,
  reply: FastifyReply,
): Promise<{ draft: SummaryTemplateDraft; base: SummaryTemplate | null } | null> {
  const parsed = SummaryTemplateDraftSchema.safeParse(body ?? {});
  if (!parsed.success) {
    await reply.code(400).send({
      error: "invalid_template",
      message: "This template could not be saved as written.",
    });
    return null;
  }

  // Not naming a base means inheriting from the system template. That is the useful default:
  // a user who only wants one extra section gets the standard layout underneath it, and later
  // improvements to the standard reach their template (ADR-004 §1).
  const basedOn = parsed.data.basedOn === undefined ? SYSTEM_TEMPLATE_ID : parsed.data.basedOn;
  const draft: SummaryTemplateDraft = { ...parsed.data, basedOn };

  let base: SummaryTemplate | null = null;
  if (basedOn !== null) {
    base = await store.findTemplate(scope, basedOn);
    if (!base) {
      await reply.code(400).send({
        error: "invalid_template",
        message: "The template this one builds on is not available.",
      });
      return null;
    }
    if (base.basedOn !== null) {
      // ADR-004 §1 allows exactly one level. Chains would make "what changed" unanswerable.
      await reply.code(400).send({
        error: "invalid_template",
        message: "A template can only build on a template that builds on nothing itself.",
      });
      return null;
    }
  }

  // Resolved through the same builder the store uses, so validation cannot pass on a shape the
  // store would go on to write differently.
  const candidate = templateFromDraft(draft, { id: VALIDATION_ID, version: 1 });

  try {
    resolveTemplateSections(candidate, base);
  } catch (error) {
    if (!(error instanceof TemplateResolutionError)) throw error;
    await reply.code(400).send({
      error: "invalid_template",
      message: "This template has no sections left to write.",
    });
    return null;
  }

  return { draft, base };
}

/**
 * Builds the API view of a template: the stored document plus the section list a summary would
 * actually use, so the editor previews the same resolution the worker performs.
 *
 * A template whose base is missing or whose overrides cancel everything out is returned with an
 * empty `resolvedSections` rather than failing the request — the user has to be able to open a
 * broken template in order to fix it.
 */
export function toView(
  template: SummaryTemplate,
  candidates: readonly SummaryTemplate[],
  defaultTemplateId: string | null = null,
): SummaryTemplateView {
  const base =
    template.basedOn === null
      ? null
      : (candidates.find((candidate) => candidate.id === template.basedOn) ?? null);

  let resolvedSections: SummaryTemplateView["resolvedSections"] = [];
  try {
    resolvedSections = resolveTemplateSections(template, base);
  } catch (error) {
    if (!(error instanceof TemplateResolutionError)) throw error;
  }

  return {
    template,
    resolvedSections,
    editable: template.scope === "user",
    // A caller who has chosen nothing is on the system template, so exactly one
    // template in a list is marked rather than none — the screen never has to
    // explain an absence.
    isDefault: (defaultTemplateId ?? SYSTEM_TEMPLATE_ID) === template.id,
  };
}

async function loadBase(
  store: SummaryTemplateStore,
  scope: TemplateScope,
  template: SummaryTemplate,
): Promise<SummaryTemplate | null> {
  if (template.basedOn === null) return null;
  return store.findTemplate(scope, template.basedOn);
}

function scopeOf(context: { tenantId: string; userId: string }): TemplateScope {
  return { tenantId: context.tenantId, userId: context.userId };
}

function unavailable(error: unknown, reply: FastifyReply): FastifyReply {
  if (!(error instanceof TemplatesUnavailableError)) throw error;
  return reply.code(503).send({
    error: "templates_unavailable",
    message: "Templates cannot be saved right now. Try again shortly.",
  });
}

function notFound(): { error: string; message: string } {
  return { error: "template_not_found", message: "No template with this id exists." };
}

export const templateRoutes = fp(templateRoutesImpl, {
  name: "quorum-summary-templates",
  fastify: "5.x",
});

export default templateRoutes;
