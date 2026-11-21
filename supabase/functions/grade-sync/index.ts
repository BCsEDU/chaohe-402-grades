import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_SUBJECTS = new Set(["chinese", "math", "integrated", "pe", "flexible", "school_based"]);
const VALID_CATEGORIES = new Set(["quiz", "midterm", "final"]);
const VALID_ABSENT_MODES = new Set(["exclude", "zero"]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function getSecretKey(): string {
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretJson) {
    try {
      const parsed = JSON.parse(secretJson);
      if (parsed?.default) return String(parsed.default);
    } catch {
      // Fallback
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function getAllowedClientKeys(): string[] {
  const keys: string[] = [];
  const pubJson = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (pubJson) {
    try {
      const parsed = JSON.parse(pubJson);
      Object.values(parsed).forEach((v) => {
        if (typeof v === "string" && v) keys.push(v);
      });
    } catch {
      // Ignore
    }
  }
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon) keys.push(anon);
  keys.push("sb_publishable_4_8Lj3idSkZ0z74V4AIpRA_qqyEicMd");
  return keys;
}

function isAuthorizedClient(req: Request): boolean {
  const allowed = getAllowedClientKeys();
  if (allowed.length === 0) return true;
  const apiKey = req.headers.get("apikey") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return allowed.includes(apiKey) || (bearer !== "" && allowed.includes(bearer));
}

function isValidSeat(val: unknown, maxSeat = 50): val is number {
  const n = Number(val);
  return Number.isInteger(n) && n >= 1 && n <= maxSeat;
}

function normalizeSeatArray(raw: unknown, maxSeat: number, fallback: number[] = []): number[] {
  if (!Array.isArray(raw)) return fallback;
  return Array.from(
    new Set(raw.map((n) => Number(n)).filter((n) => isValidSeat(n, maxSeat))),
  ).sort((a, b) => a - b);
}

function parseScoreValue(
  raw: unknown,
  maxScore: number,
): { valid: boolean; value: number | "ABSENT" | "EXEMPT" | null; error?: string } {
  if (raw === null || raw === undefined || raw === "") {
    return { valid: true, value: null };
  }
  if (raw === "ABSENT") return { valid: true, value: "ABSENT" };
  if (raw === "EXEMPT") return { valid: true, value: "EXEMPT" };
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    return { valid: false, error: "分數不可為負數" };
  }
  if (num > maxScore) {
    return { valid: false, error: `分數不可超過滿分 ${maxScore}` };
  }
  return { valid: true, value: Math.round(num * 100) / 100 };
}

function toDbScoreFields(value: number | "ABSENT" | "EXEMPT" | null) {
  if (value === null) return { score_status: "NUM", score_num: null };
  if (value === "ABSENT") return { score_status: "ABSENT", score_num: null };
  if (value === "EXEMPT") return { score_status: "EXEMPT", score_num: null };
  return { score_status: "NUM", score_num: value };
}

function fromDbScoreRow(row: {
  score_status?: string;
  score_num?: number | string | null;
}): number | "ABSENT" | "EXEMPT" | null {
  if (row.score_status === "ABSENT") return "ABSENT";
  if (row.score_status === "EXEMPT") return "EXEMPT";
  if (row.score_num !== null && row.score_num !== undefined) {
    const n = Number(row.score_num);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function fetchFullState(
  supabaseAdmin: ReturnType<typeof createClient>,
  role: "teacher" | "helper",
) {
  const [settingsRes, assessmentsRes, scoresRes] = await Promise.all([
    supabaseAdmin.from("grade_settings").select("*").eq("id", "default").maybeSingle(),
    supabaseAdmin
      .from("grade_assessments")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabaseAdmin.from("grade_scores").select("*"),
  ]);

  const firstErr = settingsRes.error ?? assessmentsRes.error ?? scoresRes.error;
  if (firstErr) {
    return { error: firstErr };
  }

  const rawSet = settingsRes.data ?? {
    id: "default",
    class_name: "402 班",
    semester_name: "115 學年度第 1 學期",
    max_seat: 29,
    test_seats: [29],
    inactive_seats: [],
    include_test_in_stats: false,
    absent_mode: "exclude",
    helper_enabled: true,
    helper_pin: "4020",
  };

  const settings = {
    className: String(rawSet.class_name ?? "402 班"),
    semesterName: String(rawSet.semester_name ?? "115 學年度第 1 學期"),
    maxSeat: Number(rawSet.max_seat ?? 29),
    testSeats: Array.isArray(rawSet.test_seats) ? rawSet.test_seats.map(Number) : [29],
    inactiveSeats: Array.isArray(rawSet.inactive_seats) ? rawSet.inactive_seats.map(Number) : [],
    includeTestInStats: Boolean(rawSet.include_test_in_stats),
    absentMode: rawSet.absent_mode === "zero" ? "zero" : "exclude",
    studentHelperMode: role === "helper",
    helperEnabled: Boolean(rawSet.helper_enabled ?? true),
    ...(role === "teacher" ? { helperPin: String(rawSet.helper_pin ?? "4020") } : {}),
  };

  const scoresByAssessment = new Map<string, Record<string, number | string>>();
  const notesByAssessment = new Map<string, Record<string, string>>();

  for (const row of scoresRes.data ?? []) {
    const aid = String(row.assessment_id);
    const seatKey = String(row.seat);
    const parsedVal = fromDbScoreRow(row);
    if (parsedVal !== null) {
      if (!scoresByAssessment.has(aid)) scoresByAssessment.set(aid, {});
      scoresByAssessment.get(aid)![seatKey] = parsedVal;
    }
    if (role === "teacher" && typeof row.note === "string" && row.note.trim()) {
      if (!notesByAssessment.has(aid)) notesByAssessment.set(aid, {});
      notesByAssessment.get(aid)![seatKey] = row.note.trim();
    }
  }

  const assessments = (assessmentsRes.data ?? []).map((a) => ({
    id: String(a.id),
    subjectId: String(a.subject_id),
    category: String(a.category),
    title: String(a.title),
    date: String(a.exam_date ?? ""),
    maxScore: Number(a.max_score ?? 100),
    order: Number(a.sort_order ?? 0),
    locked: Boolean(a.locked),
    scores: scoresByAssessment.get(String(a.id)) ?? {},
    notes: role === "teacher" ? (notesByAssessment.get(String(a.id)) ?? {}) : {},
  }));

  return {
    state: {
      role,
      settings,
      assessments,
      serverTime: new Date().toISOString(),
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!isAuthorizedClient(req)) {
    return jsonResponse({ error: "Forbidden client" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) {
    return jsonResponse({ error: "Missing Supabase server configuration" }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    const action = String(body?.action ?? "");
    const pw = typeof body?.pw === "string" ? body.pw : "";
    const helperPin = typeof body?.helper_pin === "string" ? body.helper_pin.trim() : "";

    let role: "teacher" | "helper" | null = null;

    if (pw) {
      const { data: pwRow, error: pwErr } = await supabaseAdmin
        .from("teacher_config")
        .select("pw")
        .eq("pw", pw)
        .maybeSingle();
      if (!pwErr && pwRow) {
        role = "teacher";
      }
    }

    if (!role && helperPin) {
      const { data: setRow, error: setErr } = await supabaseAdmin
        .from("grade_settings")
        .select("helper_enabled, helper_pin")
        .eq("id", "default")
        .maybeSingle();
      if (!setErr && setRow && setRow.helper_enabled && setRow.helper_pin && setRow.helper_pin === helperPin) {
        role = "helper";
      }
    }

    if (!role) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    // 學生協助模式嚴格權限白名單（後端阻擋其他所有操作）
    const HELPER_ALLOWED_ACTIONS = new Set([
      "helper_get_state",
      "helper_add_assessment",
      "helper_set_score",
    ]);
    if (role === "helper" && !HELPER_ALLOWED_ACTIONS.has(action)) {
      return jsonResponse({ error: "學生協助模式不允許執行此操作" }, 403);
    }

    // ==========================================
    // 1. 拉取完整狀態（教師或小老師）
    // ==========================================
    if (action === "get_state" || action === "helper_get_state") {
      const res = await fetchFullState(supabaseAdmin, role);
      if ("error" in res && res.error) {
        return jsonResponse({ error: res.error.message }, 500);
      }
      return jsonResponse({ ok: true, ...res.state });
    }

    // ==========================================
    // 2. 新增考試項目（教師與小老師皆可用）
    // ==========================================
    if (action === "add_assessment" || action === "helper_add_assessment") {
      const subjectId = String(body?.subjectId ?? "");
      const category = String(body?.category ?? "quiz");
      const maxScoreRaw = Number(body?.maxScore ?? 100);
      const maxScore = Number.isFinite(maxScoreRaw) && maxScoreRaw > 0 && maxScoreRaw <= 1000 ? maxScoreRaw : 100;

      if (!VALID_SUBJECTS.has(subjectId) || !VALID_CATEGORIES.has(category)) {
        return jsonResponse({ error: "Invalid subject or category" }, 400);
      }

      const { data: existingRows } = await supabaseAdmin
        .from("grade_assessments")
        .select("id, category, sort_order")
        .eq("subject_id", subjectId);

      const catCount = (existingRows ?? []).filter((r) => r.category === category).length;
      const maxOrder = (existingRows ?? []).reduce((m, r) => Math.max(m, Number(r.sort_order ?? 0)), 0);
      const defaultTitle =
        category === "quiz"
          ? `第${catCount + 1}次小考`
          : category === "midterm"
            ? catCount === 0
              ? "期中考"
              : `期中考(${catCount + 1})`
            : catCount === 0
              ? "期末考"
              : `期末考(${catCount + 1})`;

      const title = String(body?.title ?? "").trim().slice(0, 60) || defaultTitle;
      const id =
        typeof body?.id === "string" && body.id.trim()
          ? body.id.trim().slice(0, 80)
          : `${subjectId}_${category}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      const { data, error } = await supabaseAdmin
        .from("grade_assessments")
        .insert({
          id,
          subject_id: subjectId,
          category,
          title,
          exam_date: String(body?.date ?? "").slice(0, 20),
          max_score: maxScore,
          sort_order: maxOrder + 1,
          locked: false,
        })
        .select("*")
        .single();

      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({
        ok: true,
        assessment: {
          id: String(data.id),
          subjectId: String(data.subject_id),
          category: String(data.category),
          title: String(data.title),
          date: String(data.exam_date ?? ""),
          maxScore: Number(data.max_score),
          order: Number(data.sort_order),
          locked: Boolean(data.locked),
          scores: {},
          notes: {},
        },
      });
    }

    // ==========================================
    // 3. 輸入或更新單格成績（教師與小老師皆可用，但受 locked 保護）
    // ==========================================
    if (action === "set_score" || action === "helper_set_score") {
      const assessmentId = String(body?.assessmentId ?? "").trim();
      const seat = Number(body?.seat);
      if (!assessmentId || !isValidSeat(seat, 50)) {
        return jsonResponse({ error: "無效的評量或座號" }, 400);
      }

      const { data: assessRow, error: aErr } = await supabaseAdmin
        .from("grade_assessments")
        .select("id, max_score, locked")
        .eq("id", assessmentId)
        .maybeSingle();

      if (aErr || !assessRow) {
        return jsonResponse({ error: "找不到該評量欄位" }, 404);
      }
      if (assessRow.locked) {
        return jsonResponse({ error: "此欄位已鎖定，請教師先解除鎖定" }, 403);
      }

      const parsed = parseScoreValue(body?.value, Number(assessRow.max_score ?? 100));
      if (!parsed.valid) {
        return jsonResponse({ error: parsed.error ?? "分數格式錯誤" }, 400);
      }

      if (parsed.value === null) {
        // 若有備註則保留列僅清空分數，否則直接刪列
        const { data: existingScore } = await supabaseAdmin
          .from("grade_scores")
          .select("id, note")
          .eq("assessment_id", assessmentId)
          .eq("seat", seat)
          .maybeSingle();

        if (existingScore && existingScore.note && String(existingScore.note).trim() !== "") {
          const { error: updErr } = await supabaseAdmin
            .from("grade_scores")
            .update({ score_status: "NUM", score_num: null })
            .eq("id", existingScore.id);
          if (updErr) return jsonResponse({ error: updErr.message }, 500);
        } else {
          const { error: delErr } = await supabaseAdmin
            .from("grade_scores")
            .delete()
            .eq("assessment_id", assessmentId)
            .eq("seat", seat);
          if (delErr) return jsonResponse({ error: delErr.message }, 500);
        }
        return jsonResponse({ ok: true, value: null });
      }

      const fields = toDbScoreFields(parsed.value);
      const { error: upErr } = await supabaseAdmin
        .from("grade_scores")
        .upsert(
          {
            assessment_id: assessmentId,
            seat,
            ...fields,
          },
          { onConflict: "assessment_id,seat" },
        );
      if (upErr) return jsonResponse({ error: upErr.message }, 500);
      return jsonResponse({ ok: true, value: parsed.value });
    }

    // 以下所有功能僅限教師密碼通過者使用
    if (role !== "teacher") {
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    // 4. 更新班級與平板通行設定
    if (action === "update_settings") {
      const { data: cur } = await supabaseAdmin
        .from("grade_settings")
        .select("*")
        .eq("id", "default")
        .maybeSingle();

      const maxSeatRaw = body?.maxSeat ?? cur?.max_seat ?? 29;
      const maxSeat = isValidSeat(maxSeatRaw, 50) ? Number(maxSeatRaw) : 29;
      const className = String(body?.className ?? cur?.class_name ?? "402 班").trim().slice(0, 40) || "402 班";
      const semesterName =
        String(body?.semesterName ?? cur?.semester_name ?? "115 學年度第 1 學期").trim().slice(0, 60) ||
        "115 學年度第 1 學期";
      const testSeats = normalizeSeatArray(body?.testSeats ?? cur?.test_seats, maxSeat, [29]);
      const inactiveSeats = normalizeSeatArray(body?.inactiveSeats ?? cur?.inactive_seats, maxSeat, []);
      const includeTestInStats =
        body?.includeTestInStats !== undefined
          ? Boolean(body.includeTestInStats)
          : Boolean(cur?.include_test_in_stats ?? false);
      const absentMode = VALID_ABSENT_MODES.has(String(body?.absentMode))
        ? String(body.absentMode)
        : String(cur?.absent_mode ?? "exclude");
      const helperEnabled =
        body?.helperEnabled !== undefined ? Boolean(body.helperEnabled) : Boolean(cur?.helper_enabled ?? true);
      const helperPinNew =
        body?.helperPin !== undefined ? String(body.helperPin).trim().slice(0, 20) : String(cur?.helper_pin ?? "4020");

      const { error } = await supabaseAdmin.from("grade_settings").upsert(
        {
          id: "default",
          class_name: className,
          semester_name: semesterName,
          max_seat: maxSeat,
          test_seats: testSeats,
          inactive_seats: inactiveSeats,
          include_test_in_stats: includeTestInStats,
          absent_mode: absentMode,
          helper_enabled: helperEnabled,
          helper_pin: helperPinNew,
        },
        { onConflict: "id" },
      );
      if (error) return jsonResponse({ error: error.message }, 500);
      const full = await fetchFullState(supabaseAdmin, "teacher");
      return jsonResponse({ ok: true, ...full.state });
    }

    // 5. 鎖定 / 解鎖直欄
    if (action === "set_locked") {
      const id = String(body?.assessmentId ?? "").trim();
      const locked = Boolean(body?.locked);
      const { error } = await supabaseAdmin.from("grade_assessments").update({ locked }).eq("id", id);
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ ok: true, id, locked });
    }

    // 6. 編輯欄位屬性（受 locked 保護）
    if (action === "update_assessment") {
      const id = String(body?.assessmentId ?? "").trim();
      const { data: row } = await supabaseAdmin
        .from("grade_assessments")
        .select("id, locked")
        .eq("id", id)
        .maybeSingle();
      if (!row) return jsonResponse({ error: "找不到評量" }, 404);
      if (row.locked) return jsonResponse({ error: "此欄位已鎖定，請先解鎖" }, 403);

      const patch: Record<string, unknown> = {};
      if (typeof body?.title === "string" && body.title.trim()) {
        patch.title = body.title.trim().slice(0, 60);
      }
      if (typeof body?.date === "string") {
        patch.exam_date = body.date.slice(0, 20);
      }
      if (VALID_CATEGORIES.has(String(body?.category))) {
        patch.category = String(body.category);
      }
      if (body?.maxScore !== undefined && Number(body.maxScore) > 0 && Number(body.maxScore) <= 1000) {
        patch.max_score = Number(body.maxScore);
      }

      const { error } = await supabaseAdmin.from("grade_assessments").update(patch).eq("id", id);
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    // 7. 刪除欄位（受 locked 保護）
    if (action === "delete_assessment") {
      const id = String(body?.assessmentId ?? "").trim();
      const { data: row } = await supabaseAdmin
        .from("grade_assessments")
        .select("id, locked")
        .eq("id", id)
        .maybeSingle();
      if (!row) return jsonResponse({ error: "找不到評量" }, 404);
      if (row.locked) return jsonResponse({ error: "此欄位已鎖定，無法刪除" }, 403);

      const { error } = await supabaseAdmin.from("grade_assessments").delete().eq("id", id);
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    // 8. 設定儲存格備註
    if (action === "set_note") {
      const assessmentId = String(body?.assessmentId ?? "").trim();
      const seat = Number(body?.seat);
      const note = String(body?.note ?? "").trim().slice(0, 120);
      if (!assessmentId || !isValidSeat(seat, 50)) {
        return jsonResponse({ error: "Invalid note target" }, 400);
      }
      const { data: assess } = await supabaseAdmin
        .from("grade_assessments")
        .select("id, locked")
        .eq("id", assessmentId)
        .maybeSingle();
      if (!assess) return jsonResponse({ error: "找不到評量" }, 404);
      if (assess.locked) return jsonResponse({ error: "此欄位已鎖定" }, 403);

      const { data: existing } = await supabaseAdmin
        .from("grade_scores")
        .select("*")
        .eq("assessment_id", assessmentId)
        .eq("seat", seat)
        .maybeSingle();

      if (!note) {
        if (existing) {
          if (existing.score_status === "NUM" && existing.score_num === null) {
            await supabaseAdmin.from("grade_scores").delete().eq("id", existing.id);
          } else {
            await supabaseAdmin.from("grade_scores").update({ note: "" }).eq("id", existing.id);
          }
        }
        return jsonResponse({ ok: true });
      }

      if (existing) {
        const { error } = await supabaseAdmin.from("grade_scores").update({ note }).eq("id", existing.id);
        if (error) return jsonResponse({ error: error.message }, 500);
      } else {
        const { error } = await supabaseAdmin.from("grade_scores").insert({
          assessment_id: assessmentId,
          seat,
          score_status: "NUM",
          score_num: null,
          note,
        });
        if (error) return jsonResponse({ error: error.message }, 500);
      }
      return jsonResponse({ ok: true });
    }

    // 9. 整欄加扣分或清空
    if (action === "bulk_adjust") {
      const id = String(body?.assessmentId ?? "").trim();
      const mode = String(body?.mode ?? "");
      const delta = Number(body?.delta ?? 0);

      const { data: assess } = await supabaseAdmin
        .from("grade_assessments")
        .select("id, max_score, locked")
        .eq("id", id)
        .maybeSingle();
      if (!assess) return jsonResponse({ error: "找不到評量" }, 404);
      if (assess.locked) return jsonResponse({ error: "此欄位已鎖定" }, 403);

      if (mode === "clear") {
        const { error } = await supabaseAdmin.from("grade_scores").delete().eq("assessment_id", id);
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ ok: true });
      }

      if (mode === "add" && Number.isFinite(delta)) {
        const maxScore = Number(assess.max_score ?? 100);
        const { data: rows } = await supabaseAdmin
          .from("grade_scores")
          .select("*")
          .eq("assessment_id", id)
          .eq("score_status", "NUM")
          .not("score_num", "is", null);

        const updates = (rows ?? []).map((r) => ({
          assessment_id: id,
          seat: r.seat,
          score_status: "NUM",
          score_num: Math.max(0, Math.min(maxScore, Math.round((Number(r.score_num) + delta) * 100) / 100)),
        }));
        if (updates.length > 0) {
          const { error } = await supabaseAdmin
            .from("grade_scores")
            .upsert(updates, { onConflict: "assessment_id,seat" });
          if (error) return jsonResponse({ error: error.message }, 500);
        }
        return jsonResponse({ ok: true, changed: updates.length });
      }

      return jsonResponse({ error: "Invalid bulk adjust mode" }, 400);
    }

    // 10. 批次 CSV 匯入
    if (action === "import_operations") {
      const ops = Array.isArray(body?.operations) ? body.operations : [];
      const overwriteExisting = body?.overwriteExisting !== false;
      const includeTestSeats = body?.includeTestSeats !== false;

      const { data: setRow } = await supabaseAdmin
        .from("grade_settings")
        .select("max_seat, test_seats")
        .eq("id", "default")
        .maybeSingle();
      const maxSeat = Number(setRow?.max_seat ?? 29);
      const testSet = new Set<number>(Array.isArray(setRow?.test_seats) ? setRow.test_seats.map(Number) : [29]);

      const { data: curAssess } = await supabaseAdmin.from("grade_assessments").select("*");
      const { data: curScores } = await supabaseAdmin.from("grade_scores").select("*");

      const assessById = new Map<string, Record<string, unknown>>();
      const assessByKey = new Map<string, Record<string, unknown>>();
      let maxOrder = 0;

      for (const a of curAssess ?? []) {
        assessById.set(String(a.id), a);
        assessByKey.set(`${a.subject_id}|${a.category}|${a.title}`, a);
        maxOrder = Math.max(maxOrder, Number(a.sort_order ?? 0));
      }

      const existingScoreSet = new Set<string>();
      for (const s of curScores ?? []) {
        if (s.score_status !== "NUM" || s.score_num !== null) {
          existingScoreSet.add(`${s.assessment_id}|${s.seat}`);
        }
      }

      const newAssessments: Array<Record<string, unknown>> = [];
      const upsertScoresMap = new Map<string, Record<string, unknown>>();
      const subjectsWithOtherQuizzes = new Set<string>();

      let addedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      for (const op of ops) {
        const seat = Number(op?.seat);
        if (!isValidSeat(seat, maxSeat)) {
          skippedCount++;
          continue;
        }
        if (!includeTestSeats && testSet.has(seat)) {
          skippedCount++;
          continue;
        }

        const subjectId = String(op?.subjectId ?? "");
        const category = String(op?.category ?? "quiz");
        const title = String(op?.title ?? "").trim().slice(0, 60);
        if (!VALID_SUBJECTS.has(subjectId) || !VALID_CATEGORIES.has(category) || !title) {
          skippedCount++;
          continue;
        }

        let target = op?.assessmentId ? assessById.get(String(op.assessmentId)) : undefined;
        if (!target) {
          target = assessByKey.get(`${subjectId}|${category}|${title}`);
        }
        if (target && target.locked) {
          skippedCount++;
          continue;
        }
        if (!target) {
          maxOrder += 1;
          const newId = `${subjectId}_${category}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          target = {
            id: newId,
            subject_id: subjectId,
            category,
            title,
            exam_date: String(op?.date ?? "").slice(0, 20),
            max_score: Number(op?.maxScore) > 0 ? Number(op.maxScore) : 100,
            sort_order: maxOrder,
            locked: false,
          };
          assessById.set(newId, target);
          assessByKey.set(`${subjectId}|${category}|${title}`, target);
          newAssessments.push(target);
        }

        const targetId = String(target.id);
        if (category === "quiz" && targetId !== `${subjectId}_quiz_1`) {
          subjectsWithOtherQuizzes.add(subjectId);
        }

        const parsed = parseScoreValue(op?.value, Number(target.max_score ?? 100));
        if (!parsed.valid || parsed.value === null) {
          skippedCount++;
          continue;
        }

        const scoreKey = `${targetId}|${seat}`;
        const hadExisting = existingScoreSet.has(scoreKey);
        if (hadExisting && !overwriteExisting) {
          skippedCount++;
          continue;
        }

        if (hadExisting) updatedCount++;
        else {
          addedCount++;
          existingScoreSet.add(scoreKey);
        }

        const dbFields = toDbScoreFields(parsed.value);
        const noteStr = typeof op?.note === "string" && op.note.trim() ? op.note.trim().slice(0, 120) : undefined;
        upsertScoresMap.set(scoreKey, {
          assessment_id: targetId,
          seat,
          ...dbFields,
          ...(noteStr !== undefined ? { note: noteStr } : {}),
        });
      }

      if (newAssessments.length > 0) {
        const { error } = await supabaseAdmin.from("grade_assessments").insert(newAssessments);
        if (error) return jsonResponse({ error: error.message }, 500);
      }

      const upsertRows = Array.from(upsertScoresMap.values());
      if (upsertRows.length > 0) {
        const { error } = await supabaseAdmin
          .from("grade_scores")
          .upsert(upsertRows, { onConflict: "assessment_id,seat" });
        if (error) return jsonResponse({ error: error.message }, 500);
      }

      // 清理尚未填分且無備註的預設「第1次小考」
      for (const sid of subjectsWithOtherQuizzes) {
        const starterId = `${sid}_quiz_1`;
        if (assessById.has(starterId)) {
          const { count } = await supabaseAdmin
            .from("grade_scores")
            .select("id", { count: "exact", head: true })
            .eq("assessment_id", starterId);
          if ((count ?? 0) === 0) {
            await supabaseAdmin.from("grade_assessments").delete().eq("id", starterId);
          }
        }
      }

      const full = await fetchFullState(supabaseAdmin, "teacher");
      return jsonResponse({
        ok: true,
        addedCount,
        updatedCount,
        skippedCount,
        createdAssessments: newAssessments.length,
        ...full.state,
      });
    }

    // 11. 整份狀態取代（用於 JSON 還原、載入示範、復原匯入前快照、清空全部）
    if (action === "replace_full_state") {
      const payload = body?.state ?? {};
      const st = payload.settings ?? {};
      const maxSeat = isValidSeat(st.maxSeat, 50) ? Number(st.maxSeat) : 29;
      const testSeats = normalizeSeatArray(st.testSeats, maxSeat, [29]);
      const inactiveSeats = normalizeSeatArray(st.inactiveSeats, maxSeat, []);

      const { error: setErr } = await supabaseAdmin.from("grade_settings").upsert(
        {
          id: "default",
          class_name: String(st.className ?? "402 班").trim().slice(0, 40) || "402 班",
          semester_name: String(st.semesterName ?? "115 學年度第 1 學期").trim().slice(0, 60) || "115 學年度第 1 學期",
          max_seat: maxSeat,
          test_seats: testSeats,
          inactive_seats: inactiveSeats,
          include_test_in_stats: Boolean(st.includeTestInStats),
          absent_mode: VALID_ABSENT_MODES.has(String(st.absentMode)) ? String(st.absentMode) : "exclude",
          helper_enabled: st.helperEnabled !== undefined ? Boolean(st.helperEnabled) : true,
          helper_pin: st.helperPin !== undefined ? String(st.helperPin).trim().slice(0, 20) : "4020",
        },
        { onConflict: "id" },
      );
      if (setErr) return jsonResponse({ error: setErr.message }, 500);

      await supabaseAdmin.from("grade_scores").delete().gte("seat", 1);
      await supabaseAdmin.from("grade_assessments").delete().neq("id", "__none__");

      const rawAssessments = Array.isArray(payload.assessments) ? payload.assessments : [];
      const assessRows = rawAssessments
        .filter((a: Record<string, unknown>) => VALID_SUBJECTS.has(String(a?.subjectId)) && VALID_CATEGORIES.has(String(a?.category)))
        .map((a: Record<string, unknown>, idx: number) => ({
          id: String(a.id || `${a.subjectId}_${a.category}_${idx + 1}`).slice(0, 80),
          subject_id: String(a.subjectId),
          category: String(a.category),
          title: String(a.title || "未命名評量").trim().slice(0, 60) || "未命名評量",
          exam_date: String(a.date ?? "").slice(0, 20),
          max_score: Number(a.maxScore) > 0 ? Number(a.maxScore) : 100,
          sort_order: Number.isFinite(Number(a.order)) ? Number(a.order) : idx + 1,
          locked: Boolean(a.locked),
        }));

      if (assessRows.length > 0) {
        const { error: insAErr } = await supabaseAdmin.from("grade_assessments").insert(assessRows);
        if (insAErr) return jsonResponse({ error: insAErr.message }, 500);
      }

      const scoreRows: Array<Record<string, unknown>> = [];
      for (const a of rawAssessments) {
        const aid = String(a?.id ?? "");
        const maxScore = Number(a?.maxScore) > 0 ? Number(a.maxScore) : 100;
        const scoresObj = a?.scores && typeof a.scores === "object" ? a.scores : {};
        const notesObj = a?.notes && typeof a.notes === "object" ? a.notes : {};
        const seatsSeen = new Set([...Object.keys(scoresObj), ...Object.keys(notesObj)]);
        for (const sStr of seatsSeen) {
          const seat = Number(sStr);
          if (!isValidSeat(seat, maxSeat)) continue;
          const parsed = parseScoreValue(scoresObj[sStr], maxScore);
          const note = typeof notesObj[sStr] === "string" ? notesObj[sStr].trim().slice(0, 120) : "";
          if ((!parsed.valid || parsed.value === null) && !note) continue;
          const dbFields = toDbScoreFields(parsed.valid ? parsed.value : null);
          scoreRows.push({
            assessment_id: aid,
            seat,
            ...dbFields,
            note,
          });
        }
      }

      if (scoreRows.length > 0) {
        const { error: insSErr } = await supabaseAdmin.from("grade_scores").insert(scoreRows);
        if (insSErr) return jsonResponse({ error: insSErr.message }, 500);
      }

      const full = await fetchFullState(supabaseAdmin, "teacher");
      return jsonResponse({ ok: true, ...full.state });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Bad request" }, 400);
  }
});
