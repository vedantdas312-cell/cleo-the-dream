import { createHash } from 'node:crypto';

// Docs indexes are UTF-16 offsets, matching JavaScript string offsets.
// https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#Location
export function selectTab(document, tabId) {
  const flatten = tabs => tabs.flatMap(tab => [tab, ...flatten(tab.childTabs ?? [])]);
  const tab = flatten(document.tabs ?? []).find(tab => tab.tabProperties?.tabId === tabId);
  if (!tab?.documentTab?.body) throw new Error('Select an existing document body tab.');
  return tab.documentTab;
}

function containsSuggestions(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    (key.startsWith('suggested') && entry && Object.keys(entry).length > 0) || containsSuggestions(entry));
}

export function paragraphs(tab) {
  return (tab.body.content ?? []).filter(part => part.paragraph).map(part => {
    let end = part.startIndex;
    let text = '';
    for (const element of part.paragraph.elements ?? []) {
      if (!element.textRun || element.startIndex !== end) {
        throw new Error('This first slice supports contiguous text paragraphs only.');
      }
      text += element.textRun.content;
      end = element.endIndex;
      if (end !== part.startIndex + text.length) throw new Error('Unexpected document text indexes.');
    }
    return { startIndex: part.startIndex, text };
  });
}

export function planReplacement(document, { tabId, original, replacement }) {
  for (const text of [original, replacement]) {
    if (typeof text !== 'string' || !text.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(text) || !text.isWellFormed()) {
      throw new Error('Provide non-empty, single-line text without control characters.');
    }
  }
  if (original === replacement) throw new Error('The replacement does not change the clause.');
  if (!document.documentId || !document.revisionId) throw new Error('Document identity and revision are required.');
  const tab = selectTab(document, tabId);
  if (containsSuggestions(tab)) throw new Error('Resolve existing suggestions in this tab before the first-slice test.');
  if ((tab.body.content ?? []).some(part => !part.paragraph && !part.sectionBreak)) {
    throw new Error('This first slice supports plain body paragraphs, not tables or other structures.');
  }
  const matches = [];
  for (const paragraph of paragraphs(tab)) {
    let offset = paragraph.text.indexOf(original);
    while (offset !== -1) {
      matches.push(paragraph.startIndex + offset);
      offset = paragraph.text.indexOf(original, offset + 1);
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one exact excerpt; found ${matches.length}. Refine the selection.`);
  const startIndex = matches[0];
  const endIndex = startIndex + original.length;
  return {
    schemaVersion: 1,
    documentId: document.documentId,
    revisionId: document.revisionId,
    tabId, original, replacement,
    // Insert AFTER the original first: deletion offsets stay valid in suggest mode.
    // https://developers.google.com/workspace/docs/api/how-tos/suggestions
    body: {
      writeControl: { writeMode: 'SUGGEST', requiredRevisionId: document.revisionId },
      requests: [
        { insertText: { location: { index: endIndex, tabId }, text: replacement } },
        { deleteContentRange: { range: { startIndex, endIndex, tabId } } },
      ],
    },
  };
}

export function approvalDigest(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
