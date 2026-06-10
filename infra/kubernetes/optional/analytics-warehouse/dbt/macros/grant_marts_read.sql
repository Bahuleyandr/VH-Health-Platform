{% macro grant_marts_read() %}
-- Metabase (vh_metabase) reads ONLY dbt-materialized relations — never the
-- replicated raw tables (which keep their FORCEd tenant RLS and would
-- return empty/blocked anyway without BYPASSRLS). Guarded so local/CI runs
-- without the role still succeed.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'vh_metabase') then
    execute 'grant usage on schema ' || quote_ident('{{ this.schema }}') || ' to vh_metabase';
    execute 'grant select on {{ this }} to vh_metabase';
  end if;
end $$;
{% endmacro %}
