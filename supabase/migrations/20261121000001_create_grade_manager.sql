-- 學生成績管理系統資料表（雲端同步＋平板學生協助登打模式）
-- 隱私設計：雲端僅儲存座號（1~50），不儲存學生真實姓名

create table if not exists public.grade_settings (
  id text primary key default 'default',
  class_name text not null default '402 班',
  semester_name text not null default '115 學年度第 1 學期',
  max_seat integer not null default 29 check (max_seat between 1 and 50),
  test_seats integer[] not null default '{29}',
  inactive_seats integer[] not null default '{}',
  include_test_in_stats boolean not null default false,
  absent_mode text not null default 'exclude' check (absent_mode in ('exclude', 'zero')),
  helper_enabled boolean not null default true,
  helper_pin text not null default '4020',
  updated_at timestamptz not null default now()
);

insert into public.grade_settings (id)
values ('default')
on conflict (id) do nothing;

create table if not exists public.grade_assessments (
  id text primary key,
  subject_id text not null check (subject_id in ('chinese', 'math', 'integrated', 'pe', 'flexible', 'school_based')),
  category text not null check (category in ('quiz', 'midterm', 'final')),
  title text not null check (char_length(btrim(title)) > 0 and char_length(title) <= 60),
  exam_date text not null default '',
  max_score numeric(8,2) not null default 100 check (max_score > 0 and max_score <= 1000),
  sort_order numeric(12,4) not null default 0,
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_grade_assessments_subject_order
  on public.grade_assessments (subject_id, sort_order);

create table if not exists public.grade_scores (
  id bigint generated always as identity primary key,
  assessment_id text not null references public.grade_assessments(id) on delete cascade,
  seat integer not null check (seat between 1 and 50),
  score_num numeric(8,2),
  score_status text not null default 'NUM' check (score_status in ('NUM', 'ABSENT', 'EXEMPT')),
  note text not null default '',
  updated_at timestamptz not null default now(),
  constraint grade_scores_assessment_seat_unique unique (assessment_id, seat)
);

-- 起始 6 科預設評量（第1次小考、期中考、期末考）
insert into public.grade_assessments (id, subject_id, category, title, max_score, sort_order, locked)
values
  ('chinese_quiz_1', 'chinese', 'quiz', '第1次小考', 100, 1, false),
  ('chinese_midterm_1', 'chinese', 'midterm', '期中考', 100, 2, false),
  ('chinese_final_1', 'chinese', 'final', '期末考', 100, 3, false),
  ('math_quiz_1', 'math', 'quiz', '第1次小考', 100, 4, false),
  ('math_midterm_1', 'math', 'midterm', '期中考', 100, 5, false),
  ('math_final_1', 'math', 'final', '期末考', 100, 6, false),
  ('integrated_quiz_1', 'integrated', 'quiz', '第1次小考', 100, 7, false),
  ('integrated_midterm_1', 'integrated', 'midterm', '期中考', 100, 8, false),
  ('integrated_final_1', 'integrated', 'final', '期末考', 100, 9, false),
  ('pe_quiz_1', 'pe', 'quiz', '第1次小考', 100, 10, false),
  ('pe_midterm_1', 'pe', 'midterm', '期中考', 100, 11, false),
  ('pe_final_1', 'pe', 'final', '期末考', 100, 12, false),
  ('flexible_quiz_1', 'flexible', 'quiz', '第1次小考', 100, 13, false),
  ('flexible_midterm_1', 'flexible', 'midterm', '期中考', 100, 14, false),
  ('flexible_final_1', 'flexible', 'final', '期末考', 100, 15, false),
  ('school_based_quiz_1', 'school_based', 'quiz', '第1次小考', 100, 16, false),
  ('school_based_midterm_1', 'school_based', 'midterm', '期中考', 100, 17, false),
  ('school_based_final_1', 'school_based', 'final', '期末考', 100, 18, false)
on conflict (id) do nothing;

create or replace function public.set_grade_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_grade_settings_updated_at on public.grade_settings;
create trigger trg_grade_settings_updated_at
  before update on public.grade_settings
  for each row
  execute function public.set_grade_updated_at();

drop trigger if exists trg_grade_assessments_updated_at on public.grade_assessments;
create trigger trg_grade_assessments_updated_at
  before update on public.grade_assessments
  for each row
  execute function public.set_grade_updated_at();

drop trigger if exists trg_grade_scores_updated_at on public.grade_scores;
create trigger trg_grade_scores_updated_at
  before update on public.grade_scores
  for each row
  execute function public.set_grade_updated_at();

-- 最小權限原則：全面禁止匿名與一般客戶端直連，統一經由 Edge Function 驗證後存取
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'grade_settings',
    'grade_assessments',
    'grade_scores'
  ]
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from public, anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on table public.%I to service_role', tbl);
    execute format('drop policy if exists "deny_direct_client_access" on public.%I', tbl);
    execute format(
      'create policy "deny_direct_client_access" on public.%I for all to anon, authenticated using (false) with check (false)',
      tbl
    );
  end loop;
end $$;
