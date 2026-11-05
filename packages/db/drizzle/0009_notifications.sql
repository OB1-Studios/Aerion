CREATE TABLE "notification_pref" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"digest" text NOT NULL,
	"last_digest_on" date,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ALTER COLUMN "payload" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_pref" ADD CONSTRAINT "notification_pref_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_pref_ws_user" ON "notification_pref" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_ws_user_key" ON "notification" USING btree ("workspace_id","user_id","key");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("workspace_id","user_id","read_at");