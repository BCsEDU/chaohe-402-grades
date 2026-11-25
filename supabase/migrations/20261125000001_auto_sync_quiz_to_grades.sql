-- 國語／數學線上測驗自動同步至 402 班學生成績管理系統（grade_assessments / grade_scores）
-- 功能：
-- 1. 402 班學生完成線上測驗（或完成錯題訂正加分）寫入 public.submissions 時，自動建立對應科目與小考欄位並即時寫入／更新分數
-- 2. 若欄位已被教師鎖定（locked = true），自動保護不覆蓋
-- 3. 教師於測驗後台刪除作答紀錄（is_deleted = true）時，自動重算或清除該格自動同步分數
-- 4. 提供教師驗證 RPC：public.teacher_sync_exam_to_grades(pw, exam_id) 供手動補同步既有或解鎖後的試卷

-- =========================================================
-- 1. 擴充既有資料表欄位與索引（向後相容）
-- =========================================================
alter table public.submissions
  add column if not exists exam_title text;

alter table public.grade_assessments
  add column if not exists source_exam_id text;

create unique index if not exists idx_grade_assessments_source_exam_id_unique
  on public.grade_assessments (source_exam_id)
  where source_exam_id is not null;

create index if not exists idx_submissions_exam_class_seat_active
  on public.submissions (exam_id, class, seat, created_at desc)
  where not coalesce(is_deleted, false);

-- 綁定既有已手動匯入的「第九課《阿白觀察記》」，避免重複建欄
update public.grade_assessments
set source_exam_id = 'L9-chinese'
where subject_id = 'chinese'
  and category = 'quiz'
  and title = '第九課《阿白觀察記》'
  and source_exam_id is null
  and not exists (
    select 1 from public.grade_assessments g2 where g2.source_exam_id = 'L9-chinese'
  );

-- =========================================================
-- 2. 測驗代號與名稱對照表（供舊快取網頁或歷史資料解析中文課名）
-- =========================================================
create table if not exists public.quiz_exam_catalog (
  exam_id text primary key,
  subject_id text not null check (subject_id in ('chinese', 'math', 'integrated', 'pe', 'flexible', 'school_based')),
  category text not null default 'quiz' check (category in ('quiz', 'midterm', 'final')),
  title text not null check (char_length(btrim(title)) > 0 and char_length(title) <= 60),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_quiz_exam_catalog_updated_at on public.quiz_exam_catalog;
create trigger trg_quiz_exam_catalog_updated_at
  before update on public.quiz_exam_catalog
  for each row
  execute function public.set_grade_updated_at();

alter table public.quiz_exam_catalog enable row level security;
revoke all on table public.quiz_exam_catalog from public, anon, authenticated;
grant select, insert, update, delete on table public.quiz_exam_catalog to service_role;

drop policy if exists "deny_direct_client_access" on public.quiz_exam_catalog;
create policy "deny_direct_client_access"
  on public.quiz_exam_catalog
  for all
  to anon, authenticated
  using (false)
  with check (false);

insert into public.quiz_exam_catalog (exam_id, subject_id, category, title)
values
  ('L7-chinese', 'chinese', 'quiz', '第七課《到此「藝」遊》'),
  ('L8-chinese', 'chinese', 'quiz', '第八課《四季的頭髮》'),
  ('L9-chinese', 'chinese', 'quiz', '第九課《阿白觀察記》'),
  ('L10-chinese', 'chinese', 'quiz', '第十課隨堂測驗'),
  ('L11-chinese', 'chinese', 'quiz', '第十一課隨堂測驗'),
  ('L12-chinese', 'chinese', 'quiz', '第十二課隨堂測驗'),
  ('U6-math-triangle', 'math', 'quiz', '第六單元《三角形》'),
  ('U7-math-decimal', 'math', 'quiz', '第七單元《小數》'),
  ('U8-math-arithmetic', 'math', 'quiz', '第八單元《整數四則計算》'),
  ('U9-math-fraction', 'math', 'quiz', '第九單元《分數》'),
  ('U10-math-charts', 'math', 'quiz', '第十單元《統計圖》')
on conflict (exam_id) do nothing;

-- =========================================================
-- 3. 非暴露 private schema：內部同步核心函式（避免暴露為公開 RPC）
-- =========================================================
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 3a. 解析 exam_id 對應的科目與小考名稱（非目標測驗則回傳 null）
create or replace function private.resolve_quiz_meta(
  p_base_exam_id text,
  p_subject text default null,
  p_exam_title text default null
)
returns table (
  subject_id text,
  category text,
  title text
)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_clean_id text := btrim(coalesce(p_base_exam_id, ''));
  v_clean_title text := left(btrim(coalesce(p_exam_title, '')), 60);
  v_cat record;
  v_subj text := null;
  v_final_title text := null;
begin
  if v_clean_id = '' then
    return;
  end if;

  -- 排除學力檢測（g3-/g4-*）
  if v_clean_id ~* '^g[0-9]+-' then
    return;
  end if;

  -- 1. 優先查詢 catalog
  select c.subject_id, c.category, c.title
  into v_cat
  from public.quiz_exam_catalog c
  where c.exam_id = v_clean_id;

  if found then
    v_subj := v_cat.subject_id;
    -- 若前端傳入了新的正式標題，更新 catalog 並優先採用
    if v_clean_title <> '' and v_clean_title is distinct from v_cat.title then
      update public.quiz_exam_catalog
      set title = v_clean_title
      where exam_id = v_clean_id;
      v_final_title := v_clean_title;
    else
      v_final_title := v_cat.title;
    end if;

    return query select v_subj, v_cat.category, v_final_title;
    return;
  end if;

  -- 2. 依 exam_id 命名慣例自動辨識未來新增的國語課次或數學單元
  if v_clean_id ~* '^L[0-9]+-chinese$' then
    v_subj := 'chinese';
    v_final_title := coalesce(
      nullif(v_clean_title, ''),
      '第' || substring(v_clean_id from '(?i)^L([0-9]+)-') || '課隨堂測驗'
    );
  elsif v_clean_id ~* '^U[0-9]+-math' then
    v_subj := 'math';
    v_final_title := coalesce(
      nullif(v_clean_title, ''),
      '第' || substring(v_clean_id from '(?i)^U([0-9]+)-') || '單元隨堂測驗'
    );
  else
    return;
  end if;

  insert into public.quiz_exam_catalog (exam_id, subject_id, category, title)
  values (v_clean_id, v_subj, 'quiz', left(v_final_title, 60))
  on conflict (exam_id) do update
    set title = excluded.title
    where excluded.title <> '';

  return query select v_subj, 'quiz'::text, left(v_final_title, 60);
end;
$$;

-- 3b. 重算並同步單一 402 班學生在單一測驗的最終成績至 grade_assessments / grade_scores
create or replace function private.sync_quiz_student_score(
  p_base_exam_id text,
  p_seat integer,
  p_subject text default null,
  p_exam_title text default null,
  p_exam_date text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_meta record;
  v_max_seat integer := 29;
  v_main record;
  v_has_main boolean := false;
  v_retry_bonus integer := 0;
  v_retry_done boolean := false;
  v_col_bonus integer := 0;
  v_bonus integer := 0;
  v_raw_pct integer := 0;
  v_final_pct integer := 0;
  v_auto_note text := '';
  v_assess public.grade_assessments%rowtype;
  v_has_assess boolean := false;
  v_new_assess_id text;
  v_next_order numeric(12,4);
  v_exam_date text;
  v_existing_score record;
  v_starter_id text;
  v_starter_count integer;
begin
  if p_seat is null or p_seat < 1 or p_seat > 50 then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_seat');
  end if;

  select * into v_meta
  from private.resolve_quiz_meta(p_base_exam_id, p_subject, p_exam_title)
  limit 1;

  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'unsupported_exam');
  end if;

  select coalesce(max_seat, 29)
  into v_max_seat
  from public.grade_settings
  where id = 'default';

  if p_seat > v_max_seat then
    return jsonb_build_object('status', 'skipped', 'reason', 'seat_exceeds_max');
  end if;

  -- 同份試卷建欄加鎖，避免全班同時交卷產生競態
  perform pg_advisory_xact_lock(hashtext('quiz_grade_sync:' || p_base_exam_id));

  -- 取得該生在 402 班此測驗最新一筆未刪除的主卷（同時相容 '4-2' 與 '402'）
  select
    s.*,
    to_jsonb(s) as row_json
  into v_main
  from public.submissions s
  where s.exam_id = p_base_exam_id
    and s.seat = p_seat
    and not coalesce(s.is_deleted, false)
    and regexp_replace(coalesce(s.class, ''), '[^0-9]', '', 'g') = '402'
  order by s.created_at desc nulls last, s.id desc
  limit 1;
  v_has_main := found;

  -- 查找目標評量欄位（1. source_exam_id -> 2. 同科目同類別同名稱 -> 3. 自動建立）
  select * into v_assess
  from public.grade_assessments
  where source_exam_id = p_base_exam_id
  limit 1;
  v_has_assess := found;

  if not v_has_assess then
    select * into v_assess
    from public.grade_assessments
    where subject_id = v_meta.subject_id
      and category = v_meta.category
      and title = v_meta.title
    order by sort_order asc, created_at asc
    limit 1;
    v_has_assess := found;

    if v_has_assess then
      update public.grade_assessments
      set source_exam_id = p_base_exam_id
      where id = v_assess.id
        and source_exam_id is null;
    end if;
  end if;

  -- 若該生已無有效主卷（例如剛被教師刪除）
  if not v_has_main then
    if not v_has_assess then
      return jsonb_build_object('status', 'skipped', 'reason', 'no_submission_no_assessment');
    end if;
    if v_assess.locked then
      return jsonb_build_object('status', 'locked', 'assessment_id', v_assess.id, 'title', v_assess.title);
    end if;

    select id, note into v_existing_score
    from public.grade_scores
    where assessment_id = v_assess.id and seat = p_seat;

    if found then
      if coalesce(btrim(v_existing_score.note), '') <> ''
         and v_existing_score.note not like '[線上測驗]%' then
        update public.grade_scores
        set score_status = 'NUM', score_num = null
        where id = v_existing_score.id;
      else
        delete from public.grade_scores
        where id = v_existing_score.id;
      end if;
    end if;

    return jsonb_build_object('status', 'cleared', 'assessment_id', v_assess.id, 'title', v_assess.title);
  end if;

  -- 若尚無評量欄位，自動新增對應科目的小考欄位
  if not v_has_assess then
    v_exam_date := coalesce(
      nullif(btrim(coalesce(p_exam_date, '')), ''),
      to_char(coalesce(v_main.created_at, now()) at time zone 'Asia/Taipei', 'YYYY-MM-DD')
    );
    v_new_assess_id := left(
      'auto_' || v_meta.subject_id || '_' || regexp_replace(lower(p_base_exam_id), '[^a-z0-9_]+', '_', 'g'),
      80
    );
    select coalesce(max(sort_order), 0) + 1
    into v_next_order
    from public.grade_assessments;

    insert into public.grade_assessments (
      id,
      subject_id,
      category,
      title,
      exam_date,
      max_score,
      sort_order,
      locked,
      source_exam_id
    )
    values (
      v_new_assess_id,
      v_meta.subject_id,
      v_meta.category,
      v_meta.title,
      v_exam_date,
      100,
      v_next_order,
      false,
      p_base_exam_id
    )
    on conflict (id) do nothing;

    select * into v_assess
    from public.grade_assessments
    where source_exam_id = p_base_exam_id or id = v_new_assess_id
    limit 1;
    v_has_assess := found;

    -- 若該科仍留著完全空白的預設「第1次小考」，一併清理
    v_starter_id := v_meta.subject_id || '_quiz_1';
    if v_has_assess and v_assess.id is distinct from v_starter_id then
      select count(*) into v_starter_count
      from public.grade_scores
      where assessment_id = v_starter_id;

      if v_starter_count = 0 then
        delete from public.grade_assessments
        where id = v_starter_id and not locked;
      end if;
    end if;
  end if;

  if not v_has_assess then
    return jsonb_build_object('status', 'skipped', 'reason', 'assessment_create_failed');
  end if;

  -- 保護已鎖定欄位：不覆蓋教師已鎖定的分數
  if v_assess.locked then
    return jsonb_build_object(
      'status', 'locked',
      'assessment_id', v_assess.id,
      'subject_id', v_assess.subject_id,
      'title', v_assess.title
    );
  end if;

  -- 計算原始百分制分數（與 teacher.html Math.round((score/total)*100) 一致）
  if coalesce(v_main.total, 0) > 0 then
    v_raw_pct := round((v_main.score::numeric / v_main.total::numeric) * 100)::integer;
  else
    v_raw_pct := 0;
  end if;

  -- 讀取主卷欄位上的 bonus_points（相容未來升級欄位）
  if (v_main.row_json ? 'bonus_points') and (v_main.row_json->>'bonus_points') ~ '^-?[0-9]+$' then
    v_col_bonus := (v_main.row_json->>'bonus_points')::integer;
  end if;

  -- 若原卷未滿分，查找對應的 __retry 訂正紀錄（依最早有效訂正）
  if coalesce(v_main.score, 0) < coalesce(v_main.total, 0) then
    select coalesce(r.score, 0)
    into v_retry_bonus
    from public.submissions r
    where r.exam_id = p_base_exam_id || '__retry'
      and r.seat = p_seat
      and not coalesce(r.is_deleted, false)
      and regexp_replace(coalesce(r.class, ''), '[^0-9]', '', 'g') = '402'
      and (
        (v_main.client_id is not null and r.name = v_main.client_id)
        or (
          v_main.client_id is not null
          and r.name like 'M1R:%'
          and position('"' || v_main.client_id || '"' in r.name) > 0
        )
        or (
          (r.created_at at time zone 'Asia/Taipei')::date
            = (v_main.created_at at time zone 'Asia/Taipei')::date
        )
      )
    order by
      case
        when v_main.client_id is not null and (
          r.name = v_main.client_id
          or (r.name like 'M1R:%' and position('"' || v_main.client_id || '"' in r.name) > 0)
        ) then 0
        else 1
      end,
      r.created_at asc nulls last,
      r.id asc
    limit 1;

    if found then
      v_retry_done := true;
    else
      v_retry_bonus := 0;
    end if;
  end if;

  v_bonus := greatest(v_col_bonus, v_retry_bonus);
  v_final_pct := least(100, greatest(0, v_raw_pct + v_bonus));

  if coalesce(v_main.score, 0) >= coalesce(v_main.total, 0) and coalesce(v_main.total, 0) > 0 then
    v_auto_note := '[線上測驗] 原卷滿分';
  elsif v_bonus > 0 then
    v_auto_note := '[線上測驗] 原' || v_raw_pct || '分 +' || v_bonus || '訂正';
  elsif v_retry_done or ((v_main.row_json ? 'retry_passed') and v_main.row_json->>'retry_passed' = 'false') then
    v_auto_note := '[線上測驗] 原' || v_raw_pct || '分（已訂正未全對）';
  else
    v_auto_note := '[線上測驗] 原' || v_raw_pct || '分（待訂正）';
  end if;

  insert into public.grade_scores (assessment_id, seat, score_status, score_num, note)
  values (v_assess.id, p_seat, 'NUM', v_final_pct, v_auto_note)
  on conflict (assessment_id, seat) do update
    set score_status = 'NUM',
        score_num = excluded.score_num,
        note = case
          when coalesce(btrim(public.grade_scores.note), '') = ''
            or public.grade_scores.note like '[線上測驗]%'
          then excluded.note
          else public.grade_scores.note
        end;

  return jsonb_build_object(
    'status', 'synced',
    'assessment_id', v_assess.id,
    'subject_id', v_assess.subject_id,
    'title', v_assess.title,
    'seat', p_seat,
    'raw_score', v_raw_pct,
    'bonus', v_bonus,
    'final_score', v_final_pct
  );
end;
$$;

-- 3c. submissions Trigger Function：學生交卷／訂正／教師刪除時即時觸發
create or replace function private.trg_sync_submission_to_grades()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_base_exam_id text;
  v_exam_date text;
begin
  -- 只同步 402 班（同時支援 '4-2'、'402' 等格式）
  if regexp_replace(coalesce(new.class, ''), '[^0-9]', '', 'g') <> '402' then
    return new;
  end if;

  v_base_exam_id := regexp_replace(coalesce(new.exam_id, ''), '__retry$', '');
  v_exam_date := to_char(coalesce(new.created_at, now()) at time zone 'Asia/Taipei', 'YYYY-MM-DD');

  begin
    perform private.sync_quiz_student_score(
      v_base_exam_id,
      new.seat,
      new.subject,
      new.exam_title,
      v_exam_date
    );
  exception when others then
    -- 容錯保護：絕不因成績同步異常阻斷學生交卷
    raise warning 'sync_submission_to_grade_manager failed for submission %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function private.resolve_quiz_meta(text, text, text) from public, anon, authenticated;
revoke all on function private.sync_quiz_student_score(text, integer, text, text, text) from public, anon, authenticated;
revoke all on function private.trg_sync_submission_to_grades() from public, anon, authenticated;

drop trigger if exists trg_submissions_auto_sync_grades on public.submissions;
create trigger trg_submissions_auto_sync_grades
  after insert or update
  on public.submissions
  for each row
  execute function private.trg_sync_submission_to_grades();

-- =========================================================
-- 4. 教師手動補同步 RPC（給 chinese-quiz / math-quiz teacher.html 一鍵同步歷史或解鎖欄位）
-- =========================================================
create or replace function public.teacher_sync_exam_to_grades(
  pw text,
  p_exam_id text default null,
  p_exam_title text default null,
  p_subject text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_target_exam text := nullif(regexp_replace(btrim(coalesce(p_exam_id, '')), '__retry$', ''), '');
  v_target_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  v_rec record;
  v_res jsonb;
  v_synced_count integer := 0;
  v_locked_count integer := 0;
  v_skipped_count integer := 0;
  v_assessments jsonb := '[]'::jsonb;
  v_seen_assess text[] := '{}';
  v_aid text;
begin
  if not exists (
    select 1 from public.teacher_config t where t.pw = teacher_sync_exam_to_grades.pw
  ) then
    raise exception 'unauthorized';
  end if;

  for v_rec in
    select
      regexp_replace(s.exam_id, '__retry$', '') as base_exam_id,
      s.seat,
      max(s.subject) as subject,
      max(nullif(btrim(coalesce(s.exam_title, '')), '')) as exam_title,
      to_char(max(s.created_at) at time zone 'Asia/Taipei', 'YYYY-MM-DD') as exam_date
    from public.submissions s
    where not coalesce(s.is_deleted, false)
      and regexp_replace(coalesce(s.class, ''), '[^0-9]', '', 'g') = '402'
      and (
        v_target_exam is null
        or regexp_replace(s.exam_id, '__retry$', '') = v_target_exam
      )
      and (
        v_target_subject is null
        or s.subject = v_target_subject
      )
    group by regexp_replace(s.exam_id, '__retry$', ''), s.seat
    order by base_exam_id, s.seat
  loop
    v_res := private.sync_quiz_student_score(
      v_rec.base_exam_id,
      v_rec.seat,
      v_rec.subject,
      coalesce(nullif(btrim(coalesce(p_exam_title, '')), ''), v_rec.exam_title),
      v_rec.exam_date
    );

    if v_res->>'status' = 'synced' then
      v_synced_count := v_synced_count + 1;
      v_aid := v_res->>'assessment_id';
      if v_aid is not null and not (v_aid = any(v_seen_assess)) then
        v_seen_assess := array_append(v_seen_assess, v_aid);
        v_assessments := v_assessments || jsonb_build_array(jsonb_build_object(
          'assessment_id', v_aid,
          'subject_id', v_res->>'subject_id',
          'title', v_res->>'title',
          'locked', false
        ));
      end if;
    elsif v_res->>'status' = 'locked' then
      v_locked_count := v_locked_count + 1;
      v_aid := v_res->>'assessment_id';
      if v_aid is not null and not (v_aid = any(v_seen_assess)) then
        v_seen_assess := array_append(v_seen_assess, v_aid);
        v_assessments := v_assessments || jsonb_build_array(jsonb_build_object(
          'assessment_id', v_aid,
          'subject_id', v_res->>'subject_id',
          'title', v_res->>'title',
          'locked', true
        ));
      end if;
    else
      v_skipped_count := v_skipped_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'synced_count', v_synced_count,
    'locked_count', v_locked_count,
    'skipped_count', v_skipped_count,
    'assessments', v_assessments
  );
end;
$$;

revoke all on function public.teacher_sync_exam_to_grades(text, text, text, text) from public;
grant execute on function public.teacher_sync_exam_to_grades(text, text, text, text) to anon, authenticated;
