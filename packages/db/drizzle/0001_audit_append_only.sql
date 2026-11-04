-- The audit log is append-only (data spec section 2): UPDATE is always rejected, and
-- DELETE only happens when a whole workspace is purged (workspace deletion, demo reset),
-- inside a transaction that sets app.workspace_purge = 'on' (see purgeWorkspace in the db package).
CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.workspace_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_event is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_or_delete
BEFORE UPDATE OR DELETE ON "audit_event"
FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();
