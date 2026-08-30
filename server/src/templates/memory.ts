import type { SummaryTemplate, SummaryTemplateDraft } from "@quorum/shared";
import {
  byScopeThenName,
  templateFromDraft,
  type SummaryTemplateStore,
  type TemplateScope,
} from "./repository.js";

interface StoredVersion {
  template: SummaryTemplate;
  tenantId: string | null;
  userId: string | null;
}

/**
 * In-memory `SummaryTemplateStore` for tests and for the unauthenticated
 * development instance.
 *
 * It mirrors the tenant/user predicate of the SQL implementation rather than
 * filtering after the fact, so a cross-tenant read misses here for the same
 * reason it misses in PostgreSQL. Versions accumulate the same way too: an edit
 * appends, it never overwrites.
 */
export class InMemorySummaryTemplateStore implements SummaryTemplateStore {
  private readonly versions: StoredVersion[] = [];
  private nextId = 1;

  /** Test seam: adds a template as the worker's seeding would, without a tenant. */
  seedSystemTemplate(template: SummaryTemplate): void {
    this.versions.push({ template, tenantId: null, userId: null });
  }

  async listTemplates(scope: TemplateScope): Promise<SummaryTemplate[]> {
    const latest = new Map<string, SummaryTemplate>();
    for (const stored of this.versions) {
      if (!this.visible(stored, scope)) continue;
      const previous = latest.get(stored.template.id);
      if (!previous || previous.version < stored.template.version) {
        latest.set(stored.template.id, stored.template);
      }
    }
    return [...latest.values()].sort(byScopeThenName);
  }

  async findTemplate(scope: TemplateScope, templateId: string): Promise<SummaryTemplate | null> {
    const all = await this.listTemplates(scope);
    return all.find((template) => template.id === templateId) ?? null;
  }

  async createTemplate(
    scope: TemplateScope,
    draft: SummaryTemplateDraft,
  ): Promise<SummaryTemplate> {
    const template = templateFromDraft(draft, { id: this.mintId(), version: 1 });
    this.versions.push({ template, tenantId: scope.tenantId, userId: scope.userId });
    return template;
  }

  async updateTemplate(
    scope: TemplateScope,
    templateId: string,
    draft: SummaryTemplateDraft,
  ): Promise<SummaryTemplate | null> {
    const owned = this.versions.filter(
      (stored) =>
        stored.template.id === templateId &&
        stored.template.scope === "user" &&
        stored.tenantId === scope.tenantId &&
        stored.userId === scope.userId,
    );
    if (owned.length === 0) return null;

    const highest = Math.max(...owned.map((stored) => stored.template.version));
    const template = templateFromDraft(draft, { id: templateId, version: highest + 1 });
    this.versions.push({ template, tenantId: scope.tenantId, userId: scope.userId });
    return template;
  }

  async deleteTemplate(scope: TemplateScope, templateId: string): Promise<boolean> {
    const before = this.versions.length;
    for (let index = this.versions.length - 1; index >= 0; index -= 1) {
      const stored = this.versions[index];
      if (
        stored &&
        stored.template.id === templateId &&
        stored.template.scope === "user" &&
        stored.tenantId === scope.tenantId &&
        stored.userId === scope.userId
      ) {
        this.versions.splice(index, 1);
      }
    }
    return this.versions.length < before;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  private visible(stored: StoredVersion, scope: TemplateScope): boolean {
    if (stored.template.scope === "system") return true;
    return stored.tenantId === scope.tenantId && stored.userId === scope.userId;
  }

  /** Deterministic, readable ids so a failing test names the template it meant. */
  private mintId(): string {
    const index = this.nextId;
    this.nextId += 1;
    return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  }
}
