CREATE TABLE "demo_inbox_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deliver_at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"from_address" text,
	"to_address" text,
	"subject" text,
	"body_text" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind_hint" text,
	"pulled_at" timestamp with time zone,
	"pulled_by_run_id" uuid
);
--> statement-breakpoint
ALTER TABLE "draft_action" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "extracted" jsonb;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "advice_number" text;--> statement-breakpoint
ALTER TABLE "demo_inbox_item" ADD CONSTRAINT "demo_inbox_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_inbox_ws_deliver_idx" ON "demo_inbox_item" USING btree ("workspace_id","deliver_at");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_ws_key" ON "draft_action" USING btree ("workspace_id","key");