CREATE TRIGGER "tr_users_audit" BEFORE INSERT OR UPDATE ON "public"."users"
FOR EACH ROW
EXECUTE FUNCTION users_audit_func()