CREATE FUNCTION "public"."uuid_v7"() RETURNS VARCHAR(36)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN replace(uuid_generate_v4()::text, '-', '');
END
$$