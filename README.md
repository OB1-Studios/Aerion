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
| **Draft** | Drafts the month's invoice for each retainer whose billing day has come. Writes the emails (reminders, short-payment breakdowns, purpose-code corrections to the bank, "our bank details have not changed") and the internal tasks, from templates. Every number in a draft is checked against the records. |
| **Send** | Sends what a person approved, or what the policy allows on its own. |
| **Follow up** | Closes claims and promises that the money settled, and lists what needs a person. |

Each run is recorded step by step, and the run page shows what each step did and why. The **Dashboard** shows, for the tax year so far:

- what clients owe, by how late it is, and the most overdue invoices
- how many days invoices take to get paid
- what getting paid costs on each route: fees, plus conversion below the reference rate
- export proceeds banked in Pakistan, by month
- each client's record

It uses the same books and reference rates as the run. Every chart has its numbers in a table underneath.

On an invoice, a person can record a **credit note**, a **write-off** or a **void**, each with a reason. They are numbered CN-, WO- and VD- per year. The balance and every report follow at once:

- flags about the invoice that no longer hold are resolved
- an open dispute is closed by the credit
- emails waiting to go out are either held (the next run redrafts them with the new balance) or cancelled when no longer needed

A void is only possible before any money has come in. Its PDF then says VOID.

The **Tax-year file** page exports the year's credits and the banking-channel share as CSV for the accountant.

### Why a business can let it run

- **Code decides, the model reads.** Amounts, dates, currencies and IBANs are validated after extraction. A value that doesn't quote the source text, or doesn't parse, is marked for review instead of being used.
- **Numbers are checked twice.** Every amount, date and invoice number in an outgoing email must match the records, both when the email is drafted and again at send time. A draft that fails is blocked and never sent.
- **Code decides whose document it is.** A document only counts for a workspace if its IBAN or legal name matches. The model can lower that match, never raise it.
- **A policy decides what goes out.** In *supervised* mode (the default), a person approves every email. In *autopilot* mode, routine emails go out on their own, sensitive ones wait 30 minutes so anyone can cancel them, some always need a person, and there is an optional amount cap.
- **A person checks what the agent can't.** A document that fails a check (an account that isn't the workspace's, an amount that doesn't parse, a date after the document arrived, a scan with no text) goes to the review queue. A person corrects the fields beside the document and confirms, or sets it aside with a reason. The confirmed values go through the same checks as anything the model reads, and the audit log records who changed which field.
- **The workflow survives a model outage.** If inference is down or returns something unusable, built-in layout rules read the documents, the run still completes, and the failed calls are recorded.
- **Everything is on the record.** The audit log records every action by people and by the agent. Each model call is stored with its model, prompt version, tokens and cost. Running twice at the same clock changes nothing.

### Setting up your own workspace

- **Create an account**, then a workspace for a software house or a freelancer. It starts empty: nothing in it is simulated. Sign-up records the pilot terms and, separately, whether documents may be read by a model; without that consent the workspace uses the built-in layout rules only.
- **Setup** takes what goes on invoices (legal name, NTN, PSEB registration and expiry, ATL status, the email signature), the accounts money arrives in (ESFCA, PKR account, Wise, Payoneer; Pakistani IBANs are checked down to the check digits) and the invoice numbering. A checklist shows what is left. Only owners change these.
- **Clients** holds each client's currency, payment terms, usual payment route and the payer names their money arrives under. The matcher learns more names as it goes.
- **People:** an owner invites their finance person or outside accountant by email, with a role. The link works once, only for that address, for 7 days, and only a hash of it is stored. Owners can change roles or remove people, and a workspace always keeps at least one owner.
- **Mailbox:** connect the finance mailbox (Gmail, Google Workspace, Zoho or any IMAP and SMTP host) with an app password. Both logins are tested before anything is saved, and the password is stored encrypted (AES-256-GCM). Each run then reads the mail that arrived since the last one, read-only, and keeps attachments as documents. The worker checks for new mail every 15 minutes and starts an "on arrival" run when some has come in, so the agent doesn't wait for Monday. Approved emails go out through the same mailbox. Bank SMS alerts can be pasted on the Documents page.
- **Invoices** are written in the app. The editor suggests how the client should pay and says why (for example, that their last bank wire lost USD 25.00 to fees). Numbers continue after the highest one used. The A4 PDF quotes the exact payment instructions and the purpose-of-payment wording the bank needs to report the money as an IT export. Emailing an invoice goes through the approval inbox like every other email: the numbers check runs, the PDF is attached, and the copy that was sent is kept on file.
- **Retainers:** on a client's page, add the amount they pay each month and the day it's billed. Once that day comes, the next run drafts the month's invoice (dated the billing day, with the suggested route) and the email that sends it, and both wait in the inbox. Each month is drafted once, editing the draft doesn't make a second one, and earlier months are never back-filled. If a month can't be drafted (say, no account takes that currency any more), a task asks a person to fix it and the next run tries again. **Stop** ends the drafts, including a month that's due but not drafted yet.

## How it uses Vultr

| Vultr service | What it does here |
| --- | --- |
| **Cloud Compute** (Coolify marketplace image) | Runs the app as three containers from `docker-compose.yml`: `migrate` runs the migrations before every deploy, `web` serves the Next.js app, and `worker` runs the workflow and the schedules. A firewall group opens 80/443 to everyone, and SSH and the Coolify dashboard only to your IP. Daily VM backups run at 02:00 PKT. |
| **Managed Databases for PostgreSQL** | Holds all records: invoices, transactions, matches, flags, drafts, the audit log, sign-in sessions, the run queue and the cron schedules (pg-boss). It's reached over the VPC's private hostname, only from the VPC, with TLS (verified when `DATABASE_CA_CERT` is set), and backed up daily. |
| **Object Storage** | Stores the documents (credit advices, ePRCs, screenshots, wallet exports and uploads) and the PDF of every invoice as it was sent, through the S3 API, keyed by SHA-256, so the same file is never stored or counted twice. A second bucket holds the nightly database backups. At 02:30 PKT the worker writes every table from one consistent snapshot as a gzipped file sealed with AES-256-GCM, and keeps the newest 14. |
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
  records, run queue, schedules,              documents (S3 API),                  classify, extract, read replies
  audit log (private VPC host, TLS)           sealed nightly backups               (OpenAI-compatible, JSON)
```

## Reading benchmark

The model is chosen by measurement. `pnpm bench` has every reader read the answer key: 61 SIMULATED documents, each with the values it should yield, taken from the generator's own inputs so the key can't drift from the files. 16 are in the demo bank's layout. The other 45 show the same facts in layouts the built-in rules were never written for: another bank's advice, a letter, a noisy scan, other SMS wording (one in Roman Urdu), another app's screenshot and a printed MT103. Three advices are addressed to someone else. A field counts when the answer or the reading has a value, so an invented value is a miss.

| Reader | Fields right, demo layout | Fields right, other layouts | Documents fully right | Cost |
| --- | --- | --- | --- | --- |
| Layout rules (no model) | 100% | 12% | 19 of 61 | $0 |

The model rows come from `pnpm bench --models candidates`, which needs `VULTR_INFERENCE_API_KEY`. It runs every candidate model the key can use and reports tokens, cost and time per document; add `--out <dir>` to save the report. A test checks that the layout rules read every demo document exactly as the key says, and that a model which can't be reached counts as a miss rather than borrowing the rules' answer.

## Try the demo

All data is fictional and marked SIMULATED: a software house (Ravi Code Works) and a freelancer (Ayesha Siddiqui), with their invoices, bank documents, wallet exports and client emails.

- On the landing page, **Try the demo** gives you a private copy of both workspaces for 7 days (no sign-up). If you then create an account, the copy stays with you until it expires.
- Each demo workspace has its own clock. **Run now** runs the workflow at the current clock. **Next Monday →** moves the clock to the next Monday 09:00 PKT, lets that week's replies arrive, and runs the weekly workflow. **Reset** starts again.
- On **Documents**, upload your own files (PDF, CSV, text or an image, up to 10 at a time), or press **Upload a sample credit advice**. The sample is a SIMULATED bank advice for the oldest open invoice: the run reads it, matches it and marks the invoice paid. Uploads that fail a check appear under **Need a person**, where you can correct and confirm them.
- In the software house, the first Monday (2 Nov 2026) produces 6 emails to approve, 9 flags and the tasks for a person. After you approve the emails, the next Monday's replies close four flags and mark the short-paid invoice paid. The bank that didn't send a withholding certificate gets a phone-call task.
- In the freelancer's workspace, the same Monday matches two payments and leaves two emails to approve: the purpose-code correction to her bank, and the one sending Harbor & Pine's November retainer invoice (USD 2,400, billed on the 1st). The agent drafted that invoice itself because the billing day had come.
- The shared demo accounts (`pnpm seed`) are `sana@`, `hamza@ravicodeworks.example`, `qureshi@qureshi-associates.example` and `ayesha@ayeshabuilds.example`, with the password set in `DEMO_PASSWORD`. Sana owns the software house, Hamza does its finance, Qureshi is the outside accountant for both workspaces (read-only), and Ayesha is the freelancer.

**What's simulated in this build:** in the demo workspaces, the mailbox, bank alerts and wallet exports are sample data that "arrive" as the demo clock moves, and sending only records the email. A workspace you create can connect a real mailbox (IMAP in, SMTP out). There's no live connection to a bank or to Payoneer; their documents come in by email or upload.

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

`pnpm local` builds the app (again only when the source changes) and runs the workflow inside the web process, so no worker is needed. For hot reload while coding, use `pnpm dev` (the web app only, and much heavier), or `pnpm dev:all` to run the worker as well. Every command reads the `.env` at the repo root; variables already set in your shell win. Without `VULTR_INFERENCE_API_KEY`, documents are read by the built-in layout rules. With a key, `pnpm --filter @ebo/ai models` lists the models it can use. Set `VULTR_INFERENCE_MODEL` to choose one, and `pnpm --filter @ebo/ai try <file>` reads a single document with it. `pnpm bench` scores the readers against the answer key.

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
   - `APP_ENCRYPTION_KEY` (`openssl rand -hex 32`), which seals mailbox app passwords and the nightly backups. Keep a copy off the server: without it, neither can be opened
   - `DEMO_PASSWORD`
   - optionally `VULTR_API_KEY` for the live status on the settings page (restrict the key to the VM's IP)
   - optionally `DATABASE_CA_CERT` (the database's CA certificate, `\n` for line breaks) to verify the database's certificate
5. **Deploy.** The migrations run first; `web` and `worker` start only if they succeed. Load the shared demo from the worker's terminal in Coolify: `pnpm --filter @ebo/worker cli reset-demo`.
6. **Check.** `pnpm infra:status` shows the credit left and how many days it lasts at this month's spending rate, plus health, backups, model usage and pending charges. The settings page shows the same credit line, in amber when it's under USD 25 or 14 days.

Without Object Storage, documents go to a Docker volume shared by `web` and `worker`. The worker runs every queued run. `RUNS_INLINE=1` (run the workflow inside the web process) is for local development and is safe alongside a worker.

**Backups and restore.** The worker backs up the database every night to the backups bucket (`S3_BUCKET_BACKUPS`, from `infra:apply`), on top of the managed database's own daily backups and the VM's. Each backup is one file: every table, read from one consistent snapshot, with each row written by Postgres as JSON. It is gzipped and sealed with AES-256-GCM using a key derived from `APP_ENCRYPTION_KEY`. Values come back exactly, and no `pg_dump` has to match the server's version. From the worker's terminal, or locally (backups go to `./.backups`):

```bash
pnpm backup                                   # back up now, as the nightly job does
pnpm backup:list
pnpm backup:restore latest postgres://…/new   # into a new database: migrated first if blank; refuses one with data
```

The restore drill runs as a test (`packages/engine/test/backup.test.ts`). It backs up the whole database, restores it into a new one, and checks that every row came back identical. It also checks that a restore refuses a database with data, one from another release, the wrong key and a damaged file.

## Repository

| Path | What's in it |
| --- | --- |
| `apps/web` | Next.js app: landing page, sign-up and sign-in, setup, the inbox, dashboard, runs, flags, payments, clients, invoices (editor and PDF), documents, tax-year file, rules, settings, audit log |
| `apps/worker` | Claims queued runs, runs the weekly cron, the mailbox check, the nightly backup and the demo clean-up, and has a CLI (runs, demo reset, backup and restore) |
| `packages/engine` | The workflow: the eight steps, the offline document readers, PDF text, uploads and the sample credit advice, sending; workspace setup, clients, invoices with their PDF, retainers, credit notes and write-offs, people, the mailbox, the dashboard figures, and backups |
| `packages/core` | Pure rules: money, dates, matching, flags, templates, the numbers check, the approval policy |
| `packages/ai` | The Vultr Serverless Inference client, prompts, extraction schemas, model-backed readers and the reading benchmark |
| `packages/db` | Drizzle schema and migrations, storage (Object Storage or local), the demo data and its answer key |
| `packages/vultr` | A typed Vultr API client generated from the OpenAPI document, plus platform status |
| `infra` | `plan`, `apply` and `status` for the Vultr stack |

To regenerate the Vultr client, download Vultr's OpenAPI document to `packages/vultr/openapi.json` (it's gitignored) and run `pnpm vultr:types`.

## License

MIT
