import { approvalDigest, paragraphs, planReplacement, selectTab } from './docs-plan.mjs';

const API = 'https://docs.googleapis.com/v1/documents';

export function verifySuggestions(before, after, plan, ids) {
  if (after.documentId !== plan.documentId || ids.length === 0) return false;
  const elements = selectTab(after, plan.tabId).body.content.flatMap(part => part.paragraph?.elements ?? []);
  const runs = elements.filter(element => element.textRun).map(element => element.textRun);
  const marked = (run, key) => run[key]?.some(id => ids.includes(id));
  const inserted = runs.filter(run => marked(run, 'suggestedInsertionIds')).map(run => run.content).join('');
  const deleted = runs.filter(run => marked(run, 'suggestedDeletionIds')).map(run => run.content).join('');
  const original = paragraphs(selectTab(before, plan.tabId)).map(part => part.text).join('');
  const without = runs.filter(run => !run.suggestedInsertionIds?.length).map(run => run.content).join('');
  const withChanges = runs.filter(run => !run.suggestedDeletionIds?.length).map(run => run.content).join('');
  return inserted === plan.replacement && deleted === plan.original && without === original
    && withChanges === original.replace(plan.original, plan.replacement);
}

export class GoogleDocs {
  constructor({ accessToken, fetchImpl = fetch }) {
    if (!accessToken || /\s/u.test(accessToken)) throw new Error('Set a valid GOOGLE_ACCESS_TOKEN locally; never put it in a command argument.');
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }

  async request(documentId, suffix, options = {}) {
    if (!/^[\w-]+$/u.test(documentId)) throw new Error('Invalid Google document ID.');
    const response = await this.fetch(`${API}/${documentId}${suffix}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    // Do not print provider bodies: they can contain private document text.
    if (!response.ok) throw new Error(`Google Docs returned HTTP ${response.status}. Check access or re-read the document; no automatic write retry.`);
    return response.json();
  }

  async read(documentId) {
    // Only inline mode supplies edit-compatible indexes, including existing suggestions.
    // https://developers.google.com/workspace/docs/api/how-tos/suggestions
    const doc = await this.request(documentId, '?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE');
    if (doc.documentId !== documentId) throw new Error('Google returned a different document identity.');
    return doc;
  }

  async preview(documentId, change) {
    return planReplacement(await this.read(documentId), change);
  }

  async apply(plan, approvedDigest) {
    if (!approvedDigest || approvedDigest !== approvalDigest(plan)) throw new Error('Approve the exact preview digest before writing.');
    const before = await this.read(plan.documentId);
    if (before.revisionId !== plan.revisionId) throw new Error('The document changed. Create and review a fresh preview.');
    const fresh = planReplacement(before, plan);
    if (approvalDigest(fresh) !== approvedDigest) throw new Error('The preview no longer matches the current clause.');
    let response;
    try {
      // Revision protection also catches edits between the fresh read and this write.
      // https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate#WriteControl
      response = await this.request(plan.documentId, ':batchUpdate', { method: 'POST', body: JSON.stringify(fresh.body) });
    } catch (error) {
      throw new Error(`Write not confirmed. It may have reached Google; inspect the Doc before retrying. ${error.message}`);
    }
    const ids = [...new Set((response.suggestionResponses ?? []).flatMap(item => item.createdSuggestionIds ?? []))];
    try {
      const after = await this.read(plan.documentId);
      if (!verifySuggestions(before, after, plan, ids)) throw new Error('Saved text or suggestion IDs did not match.');
      return { status: 'verified-suggestions', documentId: plan.documentId, suggestionIds: ids, revisionId: after.revisionId };
    } catch (error) {
      throw new Error(`Google acknowledged the write, but readback is unverified. Do not resubmit. ${error.message}`);
    }
  }
}
