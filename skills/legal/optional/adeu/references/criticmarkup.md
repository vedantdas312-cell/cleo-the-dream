# CriticMarkup & Adeu's Semantic Projections

Load this when reading raw `read_docx` output, when the user asks about a marker you see in the projected text, or when you need to understand the appendix.

Adeu projects `.docx` into Markdown using [CriticMarkup](https://fletcher.github.io/MultiMarkdown-6/syntax/critic.html) for tracked changes and comments, plus a small set of Adeu-specific extensions for structural elements.

## CriticMarkup syntax (read-only — never write these into `new_text`)

| Marker | Meaning |
|--------|---------|
| `{++inserted text++}` | A pending tracked insertion |
| `{--deleted text--}` | A pending tracked deletion |
| `{==highlighted text==}{>>comment body<<}` | A margin comment anchored to the highlighted text |
| `{~~old~>new~~}` | Combined deletion + insertion (rare; both halves are tracked) |

**You read these.** Adeu generates them from the document's `w:ins` / `w:del` / `w:commentRangeStart` XML. **You never write them.** When applying an edit, put plain replacement text in `new_text` and use the separate `comment` field for any margin comment.

## Adeu's semantic projections

These are Adeu-specific projections of `.docx` structural elements into Markdown. They are stable, machine-readable references — not free text.

| Projection | Meaning | Editable? |
|------------|---------|-----------|
| `[^fn-<id>]` | Footnote or endnote reference. `<id>` is the stable OOXML id, not the display number. The body is appended at the bottom of the document. | Yes — edits flow through to `footnotes.xml`. |
| `[text](url)` | Hyperlink. Editing the visible `text` produces a tracked change. Editing the `url` rewrites the relationship silently (no redline). | Yes. |
| `[~display text~](#_Ref<id>)` | Cross-reference. The `[~...~]` wrapper marks the visible text as *computed* — Word recalculates it. | **No.** Modifying via `modify` is rejected. |
| `{#_BookmarkName}` | Internal anchor (Word bookmark). Structural; cannot be edited via text replacement. | **No.** Rejected by the engine. |
| `\| cell \| cell \|` | Table cells separated by virtual pipes. Each pipe is a hard `<w:tc>` boundary. | Cell *content* is editable. Adding/removing columns by adding/removing pipes is **rejected** — use `insert_row` / `delete_row` for row changes. Column changes are not supported. |

## The Markdown dialect

Adeu's projection is a strict dialect — not full CommonMark:

- **Italics use underscores only.** `_italic_` is italic; `*italic*` is literal text.
- **Bold uses double asterisks.** `**bold**`.
- **Headings** are `#` through `######`. Depths beyond 6 are rejected (`BatchValidationError`) — Word doesn't have heading styles past level 6, and silently emitting deeper Markdown would produce broken/unstyled XML.
- **Paragraph breaks** are `\n\n`. A single `\n` is a line break within the same paragraph.
- **Lists** use 4-space indentation per level to map to Word's `<w:ilvl>` nesting.

## The structural appendix

`read_docx` appends a semantic appendix below the body content, behind a `<!-- READONLY_BOUNDARY_START -->` marker. It contains:

- **Defined Terms** — terms extracted from the document by typography (leading/inline quotes), language-agnostic. Each term shows its definition and a usage count. Terms used zero times are omitted.
- **Cross-Reference Targets** — every bookmark and `_Ref` target.
- **Semantic Diagnostics** — `Unresolved` (a defined term referenced but never defined), `Unused` (defined but never used), `Duplicate`, and `Typo` warnings. Typos are grouped by target term and pruned aggressively to suppress false positives.

**Everything inside the read-only boundary is non-editable via `modify`.** The engine validates against resolved physical indices, so text edits that *coincidentally* contain a string that also appears in the appendix are still allowed — only edits actually targeting the appendix are rejected.

Use `mode="appendix"` on `read_docx` to view this section explicitly without the body.

## When this matters in practice

- Reading a contract: scan the **Defined Terms** in the appendix first. They tell you which capitalized phrases are load-bearing.
- Renaming a defined term: it's still a regular `modify` with `match_mode: "all"`, but verify the rename doesn't conflict with `Unresolved` or `Duplicate` diagnostics afterwards.
- Editing around a cross-reference: never try to rewrite `[~text~](#_Ref...)`. Edit the *source* heading that the cross-reference points to, and Word will recompute the display text on next open.
- Page numbers in `read_docx` output are Adeu's pagination, not Word's. Don't quote them back to the user as "Word page N" without checking.
