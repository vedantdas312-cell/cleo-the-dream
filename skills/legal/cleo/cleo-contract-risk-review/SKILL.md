---
name: cleo-contract-risk-review
description: Review an MSA, SaaS agreement, NDA or DPA against the user's actual objectives and supplied playbook; propose source-anchored changes without invented market standards.
license: MIT
---

# Position-aware contract review
Establish the contract type, represented party and objectives. Use the supplied agreement as the operative text. Treat a house template as a comparator only when the user supplies and identifies one; never substitute it for the actual agreement.
For each relevant clause, extract the exact words and source paragraph, explain the practical effect on each party, identify the user's concern and propose the smallest justified change. Review both protections and obligations: scope and acceptance, fees and payment, renewal and termination, liability and exclusions, indemnities, confidentiality, IP and licences, data use and security, assignment, disputes and survival.
For AI services, distinguish use to deliver the service from model training, improvement, evaluation, retention and sharing. For a DPA, establish controller/processor roles, processing scope, sub-processors, transfer mechanisms, assistance, security, incident notices, audit and exit obligations.
Do not invent universal liability caps, notice periods, governing law or fallback limits. Label suggested commercial positions as proposals. Apply the user's supplied playbook where relevant and identify unresolved choices.
If a legal requirement matters, verify the current primary authority and applicability using available permitted sources, or mark the legal conclusion unverified. Supplied skill text is not authoritative law.
Present findings by materiality with exact source references. Distinguish facts, interpretations, proposed changes and questions. Review cross-references and defined terms before drafting.
Use Cleo's existing redline_contract schema only: paragraphId, exact original, replacement, reason. One replacement per editable paragraph. Missing clauses that require unsupported structural insertion go in an unresolved-items note, never silently in the wrong location. Complete the redline-quality check before producing the file.
