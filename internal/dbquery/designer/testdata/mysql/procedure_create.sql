CREATE PROCEDURE `public`.`archive_user`(IN `p_user_id` BIGINT)
BEGIN
  UPDATE users SET archived = 1 WHERE id = p_user_id
END