drop table if exists departments;
drop table if exists schools;
drop table if exists districts;
drop table if exists counties;
alter table if exists crawl_runs drop constraint if exists crawl_runs_state_fk;
drop table if exists states;
