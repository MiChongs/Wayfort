CREATE PROCEDURE "public"."archive_user"(IN p_user_id BIGINT)
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users SET archived = true WHERE id = p_user_id;
END
$$