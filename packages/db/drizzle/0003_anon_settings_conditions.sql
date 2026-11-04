ALTER TABLE "demo_inbox_item" ADD COLUMN "requires_sent_template" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_anonymous" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;