# IT Export Back Office

An agent that runs the weekly finance back office for Pakistani software houses and IT freelancers. It makes sure every payment arrives, is matched to an invoice, and counts as an IT export. It never moves money.

Built for the lablab.ai × Vultr **Agent Rush** hackathon, Challenge 2 (Finance & Accounting: invoice processing, transaction reconciliation, anomaly flagging, payment follow-ups). It runs entirely on Vultr.

## The problem

PayPal and Stripe don't pay out to Pakistan. Exporters get paid by SWIFT wire to a Pakistani bank, through Payoneer, or by Wise into a PKR account. Every payment comes with paperwork that decides how the income is taxed: the purpose code on the remittance, the electronic Proceeds Realization Certificate (ePRC), withholding certificates, PSEB registration, and the share of income that came through banks. Today someone checks all of this by hand, every week, across bank emails, wallet exports and client threads.

## What the agent does

Every Monday at 09:00 Pakistan time (or when someone presses **Run now**), the worker runs one workflow per workspace, from planning to output:

| Step | What happens |
| --- | --- |
| **Plan** | Looks at what is waiting (new mail, open invoices, open flags, the approval policy) and records what this run will do. |
| **Pull** | Brings in what arrived since the last run: bank credit advices, ePRCs, SMS alerts, Payoneer and marketplace exports, client replies. |
| **Read** | Classifies and extracts every document and email, including the ones people upload. CSV exports are parsed by code; PDFs are read from their text layer; the rest goes to Vultr Serverless Inference, and every extracted value must quote the source text. Anything that fails a check waits for a person. |
| **Reconcile** | Links transfers between the business's own accounts, matches each credit to invoices, explains bank fees and FX, and opens the ePRC and certificate items each credit needs. |
| **Flag** | Re-checks every rule: short payments, wrong purpose codes, missing ePRCs or certificates, overdue invoices, suspicious bank-detail changes, duplicates, a low banking-channel share, PSEB and ATL status, high FX spreads, broken promises to pay. It opens new flags and closes the ones that have cleared. |
| **Draft** | Writes the emails (reminders, short-payment breakdowns, purpose-code corrections to the bank, "our bank details have not changed") and the internal tasks, from templates. Every number in a draft is checked against the records. |
| **Send** | Sends what a person approved, or what the policy allows on its own. |
| **Follow up** | Closes claims and promises that the money settled, and lists what needs a person. |

Each run is recorded step by step, and the run page shows what each step did and why. The **Tax-year file** page exports the year's credits and the banking-channel share as CSV for the accountant.

### Why a business can let it run

- **Code decides, the model reads.** Amounts, dates, currencies and IBANs are validated after extraction. A value that doesn't quote the source text, or doesn't parse, is marked for review instead of being used.
- **Numbers are checked twice.** Every amount, date and invoice number in an outgoing email must match the records, both when the email is drafted and again at send time. A draft that fails is blocked and never sent.
- **Code decides whose document it is.** A document only counts for a workspace if its IBAN or legal name matches. The model can lower that match, never raise it.
- **A policy decides what goes out.** In *supervised* mode (the default), a person approves every email. In *autopilot* mode, routine emails go out on their own, sensitive ones wait 30 minutes so anyone can cancel them, some always need a person, and there is an optional amount cap.
- **A person checks what the agent can't.** A document that fails a check (an account that isn't the workspace's, an amount that doesn't parse, a date after the document arrived, a scan with no text) goes to the review queue. A person corrects the fields beside the document and confirms, or sets it aside with a reason. The confirmed values go through the same checks as anything the model reads, and the audit log records who changed which field.
- **The workflow survives a model outage.** If inference is down or returns something unusable, built-in layout rules read the documents, the run still completes, and the failed calls are recorded.
- **Everything is on the record.** The audit log records every action by people and by the agent. Each model call is stored with its model, prompt version, tokens and cost. Running twice at the same clock changes nothing.

## How it uses Vultr

| Vultr service | What it does here |
| --- | --- |
| **Cloud Compute** (Coolify marketplace image) | Runs the app as three containers from `docker-compose.yml`: `migrate` runs the migrations before every deploy, `web` serves the Next.js app, and `worker` runs the workflow and the schedules. A firewall group opens 80/443 to everyone, and SSH and the Coolify dashboard only to your IP. Daily VM backups run at 02:00 PKT. |
| **Managed Databases for PostgreSQL** | Holds all records: invoices, transactions, matches, flags, drafts, the audit log, sign-in sessions, the run queue and the cron schedules (pg-boss). It's reached over the VPC's private hostname, only from the VPC, with TLS (verified when `DATABASE_CA_CERT` is set), and backed up daily. |
| **Object Storage** | Stores the documents (credit advices, ePRCs, screenshots, wallet exports and uploads) through the S3 API, keyed by SHA-256, so the same file is never stored or counted twice. A second bucket is created for backups but isn't used by the app yet. |
| **Serverless Inference** | Reads documents and emails through the OpenAI-compatible API: it classifies each document, extracts its fields with JSON output and a quote for each value, and reads client replies for promises to pay and claims of payment. |
| **Vultr API** | `packages/vultr` is a typed client generated from Vultr's OpenAPI document (`openapi-typescript` + `openapi-fetch`). `pnpm infra:plan / apply / status` uses it to create the whole stack. The settings page uses it to show live status: VM, backups, database, storage, and model usage and cost. |
| **DNS** (optional) | If `DOMAIN` is a Vultr DNS zone, `infra:apply` adds an A record for `app.<domain>`. |

```
Browser ── HTTPS ──▶ Coolify proxy ──▶ web (Next.js) ──── queues runs ───▶ worker (pg-boss cron + run queue)
                                       │ inbox, approvals,                  │ plan → pull → read → reconcile
                                       │ review, settings                   │ → flag → draft → send → follow-up
                     Vultr VM (Coolify, docker-compose)                     │
          ┌────────────────────────────┴──────────────┬─────────────────────┴───────────────┐
          ▼                                           ▼                                     ▼
  Managed PostgreSQL                          Object Storage                       Serverless Inference
  records, run queue, schedules,              documents (S3 API)                   classify, extract, read replies
  audit log (private VPC host, TLS)                                                (OpenAI-compatible, JSON)
```

## Try the demo

All data is fictional and marked SIMULATED: a software house (Ravi Code Works) and a freelancer (Ayesha Siddiqui), with their invoices, bank documents, wallet exports and client emails.

- On the landing page, **Try the demo** gives you a private copy of both workspaces for 7 days (no sign-up).
- Each demo workspace has its own clock. **Run now** runs the workflow at the current clock. **Next Monday →** moves the clock to the next Monday 09:00 PKT, lets that week's replies arrive, and runs the weekly workflow. **Reset** starts again.
- On **Documents**, upload your own files (PDF, CSV, text or an image, up to 10 at a time), or press **Upload a sample credit advice**. The sample is a SIMULATED bank advice for the oldest open invoice: the run reads it, matches it and marks the invoice paid. Uploads that fail a check appear under **Need a person**, where you can correct and confirm them.
- The first Monday (2 Nov 2026) produces 6 emails to approve, 9 flags and the tasks for a person. After you approve the emails, the next Monday's replies close four flags and mark the short-paid invoice paid. The bank that didn't send a withholding certificate gets a phone-call task.
- The shared demo accounts (`pnpm seed`) are `sana@`, `hamza@ravicodeworks.example`, `qureshi@qureshi-associates.example` and `ayesha@ayeshabuilds.example`, with the password set in `DEMO_PASSWORD`. Sana owns the software house, Hamza does its finance, Qureshi is the outside accountant for both workspaces (read-only), and Ayesha is the freelancer.

**What's simulated in this build:** the mailbox, bank alerts and wallet exports are sample data that "arrive" as the demo clock moves. There's no live connection to a mailbox, bank or Payoneer yet; uploaded documents are the real way in. Sending records the email in the workspace; nothing leaves the system.

## Run it locally

Needs Node 22+ and pnpm 10. No Docker is needed: the database is an embedded PostgreSQL.

```bash
pnpm install
cp .env.example .env     # set BETTER_AUTH_SECRET (openssl rand -hex 32) and DEMO_PASSWORD
pnpm dev:db              # in its own terminal: local PostgreSQL on port 54329, small-memory settings
pnpm db:migrate
pnpm seed                # the shared demo workspaces and users
pnpm local               # http://localhost:3000, a production build using about 200 MB of memory
```

`pnpm local` builds the app (again only when the source changes) and runs the workflow inside the web process, so no worker is needed. For hot reload while coding, use `pnpm dev` (the web app only, and much heavier), or `pnpm dev:all` to run the worker as well. Every command reads the `.env` at the repo root; variables already set in your shell win. Without `VULTR_INFERENCE_API_KEY`, documents are read by the built-in layout rules. With a key, `pnpm --filter @ebo/ai models` lists the models it can use. Set `VULTR_INFERENCE_MODEL` to choose one, and `pnpm --filter @ebo/ai try <file>` reads a single document with it.

```bash
pnpm typecheck
pnpm test                # unit tests, plus the full workflow against the local database
pnpm --filter @ebo/worker cli run ravi-code-works   # run one workspace from the terminal
```

## Deploy on Vultr

1. **Settings.** Put `VULTR_API_KEY` and `ADMIN_CIDR` (your IP) in `.env`, plus optionally `VULTR_REGION` (default `sgp`), `DOMAIN` and `SSH_PUBLIC_KEY_PATH`.
2. **Plan.** `pnpm infra:plan` is read-only. It shows what already exists, what would be created, the monthly cost, and how long the account's Vultr credit lasts with the new resources.
3. **Apply.** `pnpm infra:apply -- --yes` creates what's missing: the SSH key, VPC, firewall group, VM with Coolify, Managed PostgreSQL, Object Storage with its buckets, the Serverless Inference subscription and the optional DNS record. Resources are found by label, so running it again is safe. The connection details go to `.env.vultr` (secret, gitignored). *This step costs money.*
4. **Coolify.** Open `http://<vm-ip>:8000` from your IP and create the admin account. Add this repository as a **Docker Compose** resource, give the `web` service your domain on port 3000, and paste `.env.vultr` into the environment variables. Also add these:
   - `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` (`https://app.<domain>`)
   - `DEMO_PASSWORD`
   - optionally `VULTR_API_KEY` for the live status on the settings page (restrict the key to the VM's IP)
   - optionally `DATABASE_CA_CERT` (the database's CA certificate, `\n` for line breaks) to verify the database's certificate
5. **Deploy.** The migrations run first; `web` and `worker` start only if they succeed. Load the shared demo from the worker's terminal in Coolify: `pnpm --filter @ebo/worker cli reset-demo`.
6. **Check.** `pnpm infra:status` shows the credit left and how many days it lasts at this month's spending rate, plus health, backups, model usage and pending charges. The settings page shows the same credit line, in amber when it's under USD 25 or 14 days.

Without Object Storage, documents go to a Docker volume shared by `web` and `worker`. The worker runs every queued run. `RUNS_INLINE=1` (run the workflow inside the web process) is for local development and is safe alongside a worker.

## Repository

| Path | What's in it |
| --- | --- |
| `apps/web` | Next.js app: landing page, sign-in, the inbox, runs, flags, payments, invoices, documents, tax-year file, rules, settings, audit log |
| `apps/worker` | Claims queued runs, runs the weekly cron and the demo clean-up, and has a CLI |
| `packages/engine` | The workflow: the eight steps, the offline document readers, PDF text, uploads and the sample credit advice, sending |
| `packages/core` | Pure rules: money, dates, matching, flags, templates, the numbers check, the approval policy |
| `packages/ai` | The Vultr Serverless Inference client, prompts, extraction schemas and model-backed readers |
| `packages/db` | Drizzle schema and migrations, storage (Object Storage or local), the demo data |
| `packages/vultr` | A typed Vultr API client generated from the OpenAPI document, plus platform status |
| `infra` | `plan`, `apply` and `status` for the Vultr stack |

To regenerate the Vultr client, download Vultr's OpenAPI document to `packages/vultr/openapi.json` (it's gitignored) and run `pnpm vultr:types`.

## License

MIT
