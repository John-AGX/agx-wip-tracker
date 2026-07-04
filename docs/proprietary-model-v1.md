# Proprietary Model v1 — the AGX fine-tune program

*Researched + decided 2026-07-03. Companion to the training-data flywheel
(`ai_training_examples` + `server/services/training-capture.js` + the admin
"Training data" card). Strategy frame: the moat is AGX's data (see the
proprietary cost-intelligence direction) — models are rented until our
labeled-example volume makes owning one pay.*

## The verdict (July 2026 state of the world)

| Avenue | State | Call |
|---|---|---|
| **Bedrock Claude fine-tuning** | Claude 3 Haiku ONLY (a March-2024 model, us-west-2, 32k ctx); fine-tuned Claude serves **only via Provisioned Throughput** (reserved hourly capacity — no on-demand) | **Skip.** Old base + always-on hourly cost is the wrong shape for our volume. Stock Haiku 4.5 on the first-party API beats it. |
| **Bedrock RFT** | Dec-2025 launch (Nova 2 Lite) → Feb-2026 open weights (GPT-OSS 20B, Qwen 3 32B), OpenAI-compatible APIs, Lambda reward fns | **Later.** Relevant once we have reward-checkable tasks (estimate math) + data. Qwen support = converges with our model pick. |
| **Bedrock Model Distillation** | GA; Claude 3.5 Sonnet v2 → Claude Haiku etc. | Skip (dated teachers; Claude students inherit PT-only serving). |
| **Bedrock Custom Model Import (CMI)** | Import fine-tuned Qwen/Llama/Mistral/GPT-OSS free; serving $0.05718/CMU/min while active (8B ≈ 2 CMU ≈ $6.86/hr warm, 5-min windows, scales to zero) + $1.95/CMU/mo storage | **The eventual HOSTING destination** if/when P86 moves to AWS. Not the training ground. |
| **Serverless LoRA (Together AI / Fireworks)** | Training $0.48–0.50 per 1M tokens (≤16B); fine-tuned serving at base per-token rates (~$0.18/M for 8–9B); zero idle cost; weights downloadable | **The live avenue.** A full training run on our data ≈ $1–5. |

**Model pick: Qwen (Apache 2.0), small (≤9B class; Qwen-VL for vision tasks).**
No usage caps, trainable anywhere, importable to Bedrock CMI later, supported
by Bedrock RFT — zero lock-in in either direction. The downloaded adapter /
merged weights are an owned artifact (protect as a DTSA trade secret alongside
the dataset).

**The binding constraint is labeled-example count — not cost, not tech.**
The flywheel (capture hooks live in receipts, Scribe payload verdicts, PDF lead
imports, material overrides) exists to remove that constraint passively.

## Fine-tune triggers (the admin card tracks these)

| Task | Threshold | Why viable there |
|---|---|---|
| `cost_code` (receipt → materials/labor/sub/gc) | **500** | Single-label classification; smallest data need. **This is fine-tune #1.** |
| `material_normalize` | 400 | Deterministic-ish mapping; current regex has no learning at all. |
| `lead_extract` | 300 | Narrow schema; episodic volume so the bar stays low. |
| `scribe_payload` | 1,000 | Structured generation — needs more coverage across entity types. |
| `receipt_fields` | 1,500 | Vision + multi-field; needs Qwen-VL and more examples. |
| Estimating / assembly pricing assist | — | **Gated on the per-assembly cost-attribution engine** (cost-code→assembly map proven on real closed jobs), not on this table. Do not start before that exists. |

## The play for fine-tune #1 (cost-code classifier)

1. **Export**: admin → Agents → Training data → `cost_code` JSONL
   (`GET /api/admin/agents/training-export?task=cost_code`). OpenAI-chat
   format — Together/Fireworks/Bedrock all ingest it directly.
2. **Split**: hold out a random 20% as the eval set. Never train on it.
3. **Train**: Together AI LoRA SFT on a small Qwen instruct model
   (rank 16, 2–3 epochs). Expected cost: **single-digit dollars.**
4. **Eval — the bar to beat**: run BOTH the fine-tune and stock
   `claude-haiku-4-5` (the current production model) on the held-out set.
   Compare accuracy AND the live baseline from `GET /api/receipts/ocr/stats`
   (cost_code hit-rate). If the fine-tune doesn't clearly win, stop — the
   flywheel keeps filling; retry at 2× data.
5. **Shadow, don't cut over**: behind a flag, call the fine-tune alongside
   Haiku in receipt OCR and LOG agreement (extend `receipt_ocr_feedback`
   comparison) with zero user impact. Cut over only on a sustained win
   (≥2 weeks, no regression), keeping Haiku as instant fallback.
6. **Own the artifact**: download the adapter/merged weights; store in R2
   alongside the DB backups. That file + the dataset = the proprietary model.

## Serving decision at cutover

- **Now (Railway, low volume)**: keep serving from Together/Fireworks
  per-token (fine-tuned = base-model price, no idle cost).
- **If/when P86 graduates to AWS**: import the same weights to Bedrock CMI
  (supported: Qwen 2/2.5/3, incl. VL). Batch/bursty workloads fit its
  5-minute-window billing; keep sporadic single calls on serverless.
- **Never**: Bedrock Claude 3 Haiku FT (see verdict table).

## What stays on frontier Claude regardless

86 / Assistant / Scribe conversational reasoning, estimating judgment, scope
analysis, agentic loops — the managed-session stack. Fine-tunes replace only
the narrow, repetitive, structured calls (classification/extraction), where a
small owned model wins on unit economics and consistency once data volume
exists. Navigation/platform-use stays a tool-call problem (the `navigate`
tool), not a model problem.
