# Project 86 — AI Data Handling Statement

**Version:** v1 · **Date:** 2026-07-27 · **Owner:** John Thilking

> What company and customer data reaches the AI provider, under what terms, and what is retained. Written to answer the question directly: *does using the AI crew expose Project 86's data or its proprietary cost intelligence?*

## 1. Who processes the data

**Anthropic (Claude)** is the sole AI/model provider. There is no other model vendor, no third-party AI middleware, and no data broker in the path. The connection is a direct server-to-server API call from the Project 86 backend; the browser never talks to the AI provider directly, and no AI request carries the user's session credentials.

## 2. What is sent

The AI crew (86, the Assistant, the Scribe) is sent only what a turn requires:

| Sent | Examples |
|---|---|
| The user's message | The question or instruction typed in chat |
| Scoped record context | The specific job / lead / estimate / client the user is working in — fields, totals, line items |
| Documents the user submits for reading | Receipt photos, lead documents, vendor invoices, plan PDFs |
| Agent instructions | The system baseline + the organization's own curated memory/instructions |

**Not sent:** passwords or password hashes, API keys or secrets, auth tokens, or bulk exports of the database. Requests are scoped to the record in context — the model is not handed the whole dataset.

## 3. Provider terms & retention

- Project 86 uses Anthropic's **commercial API** under its commercial terms.
- **API inputs and outputs are not used to train Anthropic's models.** This is the material point for the platform's trade-secret position: submitting cost data or prompts to the API does not feed a public model.
- **Zero-retention** processing is available on request for the API tier and is the target configuration.
- Anthropic's terms, not this document, are the controlling instrument; this statement describes how the platform uses the service.

## 4. What Project 86 retains itself

Retained **inside the platform's own PostgreSQL database** — not with any third party:

| Store | Contents |
|---|---|
| `ai_messages`, `ai_sessions` | Conversation history, per organization, for continuity and auditability |
| `ai_training_examples` | The correction/training capture: model output paired with the human's corrected version |
| `org_memory` | The organization's curated standing instructions |
| Usage/token records | Per-turn token + cost attribution (the spend-forensics view) |

**The training-capture store holds references, never image bytes** — a receipt's *extracted fields* and the human correction are stored, not the photograph itself (the photo lives in the platform's own object storage under normal file access controls).

## 5. Why the proprietary data stays proprietary

The cost-intelligence dataset (assemblies, materials, AGX cost actuals, derived unit costs) and the training corpus live in Project 86's own database. Portions may transit the AI API when a user asks a question that requires them — under the commercial terms above, which exclude training use. The dataset itself is **not** licensed, uploaded, or otherwise shared with the AI provider or anyone else, and access inside the product is gated per organization.

## 6. Customer data categories in scope

The platform holds customer PII (names, addresses, contact details), GPS-tagged photographs of private property, financial records (estimates, costs, invoices, bills), and email content forwarded to the in-app inbox. AI turns may include these when they are the subject of the user's request. A written **data-classification and retention policy** covering all categories — AI-related or not — is a Stage-3 deliverable and is not yet published.

## 7. Controls

- **Per-organization scoping** on every AI read path; the model cannot be steered into another tenant's data.
- **Capability gating** — AI write actions run under the requesting user's permissions.
- **Approval gate** — deletions, system changes, and outbound sends require explicit human approval before they execute.
- **Audit trail** — privileged actions are recorded in an append-only admin audit log.
- **Spend/usage attribution** — every turn's tokens and cost are attributable by agent, surface, and conversation.

## 8. Open items (honest)

- Confirm and document the **zero-retention** setting on the account (target: Stage 1).
- Publish the **data-classification + retention policy** (Stage 3).
- A **customer-facing privacy policy** for project86.net (Stage 3) — this document is the internal/technical statement, not a public privacy notice.

*Review this statement whenever the AI provider, the model configuration, or the data sent materially changes.*
