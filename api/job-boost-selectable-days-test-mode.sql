-- Alygnn Job Boost: selectable developer-test duration
-- Run once in Supabase SQL Editor after the existing Job Boost support SQL.

begin;

drop function if exists public.activate_test_job_boost(uuid);
drop function if exists public.activate_test_job_boost(uuid,integer);

create function public.activate_test_job_boost(p_job_id uuid,p_days integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_ent public.employer_entitlements%rowtype;
  v_days integer := greatest(1,least(30,coalesce(p_days,1)));
  v_start timestamptz := now();
  v_until timestamptz;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required.'; end if;
  select * into v_ent from public.employer_entitlements where employer_id=auth.uid();
  if not found or coalesce(v_ent.test_mode,false) is not true
     or lower(coalesce(v_ent.subscription_status,'inactive')) not in ('active','trialing')
     or (v_ent.current_period_end is not null and v_ent.current_period_end<=now()) then
    raise exception using errcode='42501',message='Developer test boost is not enabled for this account.';
  end if;
  select * into v_job from public.jobs where id=p_job_id and employer_id=auth.uid() for update;
  if not found then raise exception using errcode='42501',message='You can only boost your own job.'; end if;
  if lower(coalesce(v_job.status,''))<>'active' then raise exception using errcode='22023',message='Only active jobs can be boosted.'; end if;
  v_start:=greatest(now(),coalesce(v_job.boosted_until,now()));
  v_until:=v_start+make_interval(days=>v_days);
  update public.jobs set boosted_at=now(),boosted_until=v_until where id=p_job_id;
  return jsonb_build_object('job_id',p_job_id,'days_added',v_days,'boosted_at',now(),'boosted_until',v_until,'charged_amount',0,'test_mode',true);
end;
$$;

revoke all on function public.activate_test_job_boost(uuid,integer) from public;
revoke all on function public.activate_test_job_boost(uuid,integer) from anon;
grant execute on function public.activate_test_job_boost(uuid,integer) to authenticated;

commit;
