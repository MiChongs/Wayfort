CREATE TRIGGER `public`.`tr_users_audit` BEFORE INSERT OR UPDATE ON `users` FOR EACH ROW
BEGIN
  SET NEW.updated_at = NOW()
END