BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name => 'APP_USER.EV_NIGHTLY_ARCHIVE',
    job_type => 'PLSQL_BLOCK',
    job_action => 'archive_old_sessions();',
    repeat_interval => 'FREQ=DAILY; INTERVAL=1',
    enabled => TRUE
  );
END;