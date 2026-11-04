---
name: cleo-redline-quality
description: Check exact source matches, authority, cross-references, document limits and verified delivery before returning a tracked-changes Word file.
license: MIT
---

# Verify a redline plan
Check every proposed edit against the current source_id and source_sha256. Its paragraphId must exist and be editable. Original text must match exactly. Use one combined replacement per paragraph.
Ensure each edit addresses an actual user objective or explained risk. Check defined terms, numbering, cross-references, dates, amounts and consistency with untouched clauses. Do not change unresolved terms or invent facts.
Confirm that the source was fully read for any whole-contract claim. If formatting, tables, headers, footnotes, comments or existing revisions were not inspected, report that limit. Do not claim they passed.
Keep private negotiation fallbacks and internal analysis out of the returned document. The reason field should explain the proposed edit without exposing private strategy.
Only the verified_tracked_changes tool result proves that a checked output exists. It does not prove delivery. Send only the exact returned file to the same authorized conversation, using Keiki download_url to fetch both exact generated files into separate relative sandbox paths and send_file to attach their original bytes. Keep signed transfer URLs internal unless the user explicitly requests links. Do not assume uploads are unsupported from a past failure. Check each send result separately, report partial or uncertain sending accurately, and never blindly resend a successful attachment. Confirm attachment sending only on successful send_file; a link is not proof of delivery or download.
Never substitute coloured text, a rebuilt document or an unverified link for native Word revisions. A failed readback or uncertain delivery stays uncertain until checked; avoid duplicate sends.

Prefer the smallest substantive edits. Preserve meaningful unchanged phrases; do not rewrite a satisfactory clause for style. Every comment must state a specific practical reason. The companion PDF is only a visible text comparison; the Word file remains the native tracked-changes deliverable.
