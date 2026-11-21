// 學生成績管理系統狀態管理、平均運算與本機儲存層（無加權、無等第簡潔版）
(function (global) {
  const CFG = global.GRADE_CONFIG;

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function round1(val) {
    if (val === null || val === undefined || !Number.isFinite(val)) return null;
    return Math.round(val * 10) / 10;
  }

  function clampSeat(val, maxSeat) {
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || n > maxSeat) return null;
    return n;
  }

  function createStarterAssessments() {
    const list = [];
    let order = 1;
    for (const subj of CFG.SUBJECTS) {
      list.push({
        id: `${subj.id}_quiz_1`,
        subjectId: subj.id,
        category: "quiz",
        title: "第1次小考",
        date: "",
        maxScore: 100,
        order: order++,
        locked: false,
        scores: {},
        notes: {},
      });
      list.push({
        id: `${subj.id}_midterm_1`,
        subjectId: subj.id,
        category: "midterm",
        title: "期中考",
        date: "",
        maxScore: 100,
        order: order++,
        locked: false,
        scores: {},
        notes: {},
      });
      list.push({
        id: `${subj.id}_final_1`,
        subjectId: subj.id,
        category: "final",
        title: "期末考",
        date: "",
        maxScore: 100,
        order: order++,
        locked: false,
        scores: {},
        notes: {},
      });
    }
    return list;
  }

  function createDefaultState() {
    return {
      version: 2,
      settings: clone(CFG.DEFAULT_SETTINGS),
      names: {},
      assessments: createStarterAssessments(),
      updatedAt: new Date().toISOString(),
    };
  }

  function mergeSettings(raw) {
    const base = clone(CFG.DEFAULT_SETTINGS);
    if (!raw || typeof raw !== "object") return base;

    const maxSeat =
      Number.isInteger(raw.maxSeat) && raw.maxSeat >= 1 && raw.maxSeat <= 50 ? raw.maxSeat : base.maxSeat;

    const testSeats = Array.isArray(raw.testSeats)
      ? Array.from(new Set(raw.testSeats.map((s) => clampSeat(s, maxSeat)).filter(Boolean))).sort((a, b) => a - b)
      : clone(base.testSeats);

    const inactiveSeats = Array.isArray(raw.inactiveSeats)
      ? Array.from(new Set(raw.inactiveSeats.map((s) => clampSeat(s, maxSeat)).filter(Boolean))).sort((a, b) => a - b)
      : [];

    return {
      className: typeof raw.className === "string" && raw.className.trim() ? raw.className.trim() : base.className,
      semesterName:
        typeof raw.semesterName === "string" && raw.semesterName.trim() ? raw.semesterName.trim() : base.semesterName,
      maxSeat,
      testSeats,
      inactiveSeats,
      includeTestInStats: Boolean(raw.includeTestInStats),
      hideNames: Boolean(raw.hideNames),
      absentMode: raw.absentMode === "zero" ? "zero" : "exclude",
      studentHelperMode: Boolean(raw.studentHelperMode),
      helperPin: typeof raw.helperPin === "string" ? raw.helperPin.trim().slice(0, 20) : base.helperPin,
    };
  }

  function sanitizeAssessment(raw, idx) {
    if (!raw || typeof raw !== "object") return null;
    const validSubj = CFG.SUBJECTS.some((s) => s.id === raw.subjectId);
    const validCat = CFG.CATEGORIES.some((c) => c.id === raw.category);
    if (!validSubj || !validCat) return null;

    const maxScore =
      Number.isFinite(Number(raw.maxScore)) && Number(raw.maxScore) > 0 ? Number(raw.maxScore) : 100;

    const scores = {};
    if (raw.scores && typeof raw.scores === "object") {
      for (const [k, v] of Object.entries(raw.scores)) {
        const parsed = parseCellInput(v, maxScore);
        if (parsed.valid && parsed.value !== null) {
          scores[String(Number(k))] = parsed.value;
        }
      }
    }

    const notes = {};
    if (raw.notes && typeof raw.notes === "object") {
      for (const [k, v] of Object.entries(raw.notes)) {
        if (typeof v === "string" && v.trim()) {
          notes[String(Number(k))] = v.trim().slice(0, 120);
        }
      }
    }

    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `${raw.subjectId}_${raw.category}_${idx + 1}`,
      subjectId: raw.subjectId,
      category: raw.category,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 60) : "未命名評量",
      date: typeof raw.date === "string" ? raw.date.slice(0, 20) : "",
      maxScore,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : idx + 1,
      locked: Boolean(raw.locked),
      scores,
      notes,
    };
  }

  function parseCellInput(raw, maxScore = 100) {
    if (raw === null || raw === undefined) return { valid: true, value: null };
    if (typeof raw === "number") {
      if (!Number.isFinite(raw) || raw < 0) return { valid: false, error: "分數不可為負數" };
      if (raw > maxScore) return { valid: false, error: `分數不可超過滿分 ${maxScore}` };
      return { valid: true, value: Math.round(raw * 100) / 100 };
    }
    const text = String(raw).trim();
    if (!text || text === "-" || text === "—") {
      return { valid: true, value: null };
    }
    const lower = text.toLowerCase();
    if (text === "缺" || text === "缺考" || lower === "absent" || lower === "abs" || lower === "a") {
      return { valid: true, value: "ABSENT" };
    }
    if (text === "免" || text === "免考" || lower === "exempt" || lower === "ex" || lower === "x") {
      return { valid: true, value: "EXEMPT" };
    }
    const normalized = text
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/．/g, ".")
      .replace(/分$/g, "")
      .trim();

    if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
      return { valid: false, error: "請輸入數字、「缺」或「免」" };
    }
    const num = Number(normalized);
    if (!Number.isFinite(num) || num < 0) {
      return { valid: false, error: "分數不可為負數" };
    }
    if (num > maxScore) {
      return { valid: false, error: `分數不可超過滿分 ${maxScore}` };
    }
    return { valid: true, value: Math.round(num * 100) / 100 };
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== "object") return createDefaultState();
    const settings = mergeSettings(raw.settings);
    const names = {};
    if (raw.names && typeof raw.names === "object") {
      for (const [k, v] of Object.entries(raw.names)) {
        const seat = clampSeat(k, settings.maxSeat);
        if (seat && typeof v === "string" && v.trim()) {
          names[String(seat)] = v.trim().slice(0, 30);
        }
      }
    }
    const assessments = Array.isArray(raw.assessments)
      ? raw.assessments.map((a, idx) => sanitizeAssessment(a, idx)).filter(Boolean)
      : createStarterAssessments();

    return {
      version: 2,
      settings,
      names,
      assessments,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  }

  function createStore(storageAdapter) {
    const storage = storageAdapter || (typeof localStorage !== "undefined" ? localStorage : null);
    let state = loadFromStorage();

    function loadFromStorage() {
      if (!storage) return createDefaultState();
      try {
        const raw = storage.getItem(CFG.STORAGE_KEY);
        if (!raw) return createDefaultState();
        return normalizeState(JSON.parse(raw));
      } catch (err) {
        console.warn("讀取成績本機資料失敗，改用預設資料:", err);
        return createDefaultState();
      }
    }

    function persist() {
      state.updatedAt = new Date().toISOString();
      if (!storage) return;
      try {
        storage.setItem(CFG.STORAGE_KEY, JSON.stringify(state));
      } catch (err) {
        console.error("儲存成績本機資料失敗:", err);
      }
    }

    function getState() {
      return state;
    }

    function getSeats() {
      const list = [];
      for (let s = 1; s <= state.settings.maxSeat; s++) {
        list.push(s);
      }
      return list;
    }

    function isTestSeat(seat) {
      return state.settings.testSeats.includes(Number(seat));
    }

    function isInactiveSeat(seat) {
      return state.settings.inactiveSeats.includes(Number(seat));
    }

    function isSeatIncludedInStats(seat) {
      const n = Number(seat);
      if (isInactiveSeat(n)) return false;
      if (isTestSeat(n) && !state.settings.includeTestInStats) return false;
      return true;
    }

    function getSeatName(seat, respectPrivacy = true) {
      if (respectPrivacy && state.settings.hideNames) return "";
      return state.names[String(seat)] || "";
    }

    function findSeatByName(nameStr) {
      const target = String(nameStr || "").trim();
      if (!target) return null;
      for (const [seatStr, n] of Object.entries(state.names)) {
        if (n.trim() === target) {
          return Number(seatStr);
        }
      }
      return null;
    }

    function parseRosterText(rawText) {
      const map = {};
      const lines = String(rawText || "").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^0*(\d{1,2})\s*號?\s*[,，\t\s:：\-]+\s*(.+)$/);
        if (!m) continue;
        const seat = clampSeat(m[1], state.settings.maxSeat);
        const name = m[2].trim().slice(0, 30);
        if (seat && name) {
          map[String(seat)] = name;
        }
      }
      return map;
    }

    function setNamesMap(newMap, replaceAll = true) {
      if (state.settings.studentHelperMode) return false;
      const next = replaceAll ? {} : clone(state.names);
      for (const [k, v] of Object.entries(newMap || {})) {
        const seat = clampSeat(k, state.settings.maxSeat);
        if (seat && typeof v === "string" && v.trim()) {
          next[String(seat)] = v.trim().slice(0, 30);
        }
      }
      state.names = next;
      persist();
      return true;
    }

    function updateSettings(partial) {
      if (state.settings.studentHelperMode) return state.settings;
      state.settings = mergeSettings({
        ...state.settings,
        ...partial,
      });
      persist();
      return state.settings;
    }

    function setStudentHelperMode(enabled, pinInput = "") {
      if (enabled) {
        const nextPin = typeof pinInput === "string" ? pinInput.trim().slice(0, 20) : state.settings.helperPin;
        state.settings = mergeSettings({
          ...state.settings,
          studentHelperMode: true,
          helperPin: nextPin,
        });
        persist();
        return { ok: true };
      }
      const requiredPin = state.settings.helperPin || "";
      if (requiredPin && String(pinInput || "").trim() !== requiredPin) {
        return { ok: false, error: "解除密碼錯誤，無法離開學生協助模式" };
      }
      state.settings = mergeSettings({
        ...state.settings,
        studentHelperMode: false,
      });
      persist();
      return { ok: true };
    }

    function getSubjectAssessments(subjectId, categoryFilter = "all") {
      const catRank = { quiz: 1, midterm: 2, final: 3 };
      return state.assessments
        .filter((a) => a.subjectId === subjectId && (categoryFilter === "all" || a.category === categoryFilter))
        .slice()
        .sort((a, b) => {
          const ca = catRank[a.category] || 9;
          const cb = catRank[b.category] || 9;
          if (ca !== cb) return ca - cb;
          return (a.order || 0) - (b.order || 0);
        });
    }

    function generateAssessmentId(subjectId, category) {
      const rand = Math.random().toString(36).slice(2, 7);
      return `${subjectId}_${category}_${Date.now()}_${rand}`;
    }

    function getNextDefaultTitle(subjectId, category) {
      const existing = state.assessments.filter((a) => a.subjectId === subjectId && a.category === category);
      const catName = CFG.CATEGORIES.find((c) => c.id === category)?.name || "評量";
      if (category === "quiz") {
        return `第${existing.length + 1}次小考`;
      }
      return existing.length === 0 ? catName : `${catName}(${existing.length + 1})`;
    }

    function addAssessment({ subjectId, category, title, date = "", maxScore = 100 }) {
      const cleanTitle = (title && title.trim()) || getNextDefaultTitle(subjectId, category);
      const maxOrder = state.assessments.reduce((m, a) => Math.max(m, a.order || 0), 0);
      const item = {
        id: generateAssessmentId(subjectId, category),
        subjectId,
        category,
        title: cleanTitle.slice(0, 60),
        date: String(date || "").slice(0, 20),
        maxScore: Number(maxScore) > 0 ? Number(maxScore) : 100,
        order: maxOrder + 1,
        locked: false,
        scores: {},
        notes: {},
      };
      state.assessments.push(item);
      persist();
      return item;
    }

    function setAssessmentLocked(id, locked) {
      if (state.settings.studentHelperMode) return null;
      const item = state.assessments.find((a) => a.id === id);
      if (!item) return null;
      item.locked = Boolean(locked);
      persist();
      return item;
    }

    function toggleAssessmentLock(id) {
      if (state.settings.studentHelperMode) return null;
      const item = state.assessments.find((a) => a.id === id);
      if (!item) return null;
      item.locked = !item.locked;
      persist();
      return item;
    }

    function updateAssessment(id, patch) {
      if (state.settings.studentHelperMode) return null;
      const item = state.assessments.find((a) => a.id === id);
      if (!item || item.locked) return null;
      if (typeof patch.title === "string" && patch.title.trim()) {
        item.title = patch.title.trim().slice(0, 60);
      }
      if (typeof patch.date === "string") {
        item.date = patch.date.slice(0, 20);
      }
      if (patch.category && CFG.CATEGORIES.some((c) => c.id === patch.category)) {
        item.category = patch.category;
      }
      if (patch.maxScore !== undefined && Number(patch.maxScore) > 0) {
        item.maxScore = Number(patch.maxScore);
      }
      persist();
      return item;
    }

    function deleteAssessment(id) {
      if (state.settings.studentHelperMode) return false;
      const idx = state.assessments.findIndex((a) => a.id === id);
      if (idx === -1) return false;
      if (state.assessments[idx].locked) return false;
      state.assessments.splice(idx, 1);
      persist();
      return true;
    }

    function setScore(assessmentId, seat, rawValue) {
      const item = state.assessments.find((a) => a.id === assessmentId);
      const cleanSeat = clampSeat(seat, state.settings.maxSeat);
      if (!item || !cleanSeat) return { valid: false, error: "無效的評量或座號" };
      if (item.locked) return { valid: false, error: "此欄位已鎖定，請先解除鎖定" };

      const parsed = parseCellInput(rawValue, item.maxScore);
      if (!parsed.valid) return parsed;

      if (parsed.value === null) {
        delete item.scores[String(cleanSeat)];
      } else {
        item.scores[String(cleanSeat)] = parsed.value;
      }
      persist();
      return { valid: true, value: parsed.value };
    }

    function setNote(assessmentId, seat, noteText) {
      if (state.settings.studentHelperMode) return false;
      const item = state.assessments.find((a) => a.id === assessmentId);
      const cleanSeat = clampSeat(seat, state.settings.maxSeat);
      if (!item || !cleanSeat || item.locked) return false;
      const clean = String(noteText || "").trim().slice(0, 120);
      if (!clean) {
        delete item.notes[String(cleanSeat)];
      } else {
        item.notes[String(cleanSeat)] = clean;
      }
      persist();
      return true;
    }

    function bulkAdjustAssessment(assessmentId, action, delta = 0) {
      if (state.settings.studentHelperMode) return 0;
      const item = state.assessments.find((a) => a.id === assessmentId);
      if (!item || item.locked) return 0;
      let changed = 0;
      if (action === "clear") {
        changed = Object.keys(item.scores).length;
        item.scores = {};
        persist();
        return changed;
      }
      if (action === "add") {
        const d = Number(delta);
        if (!Number.isFinite(d)) return 0;
        for (const [seatStr, val] of Object.entries(item.scores)) {
          if (typeof val === "number") {
            const next = Math.max(0, Math.min(item.maxScore, Math.round((val + d) * 100) / 100));
            if (next !== val) {
              item.scores[seatStr] = next;
              changed++;
            }
          }
        }
        persist();
        return changed;
      }
      return 0;
    }

    function normalizeScoreValue(rawVal, maxScore = 100) {
      if (rawVal === null || rawVal === undefined || rawVal === "") return null;
      if (rawVal === "EXEMPT") return null;
      if (rawVal === "ABSENT") {
        return state.settings.absentMode === "zero" ? 0 : null;
      }
      if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
        return maxScore !== 100 && maxScore > 0 ? (rawVal / maxScore) * 100 : rawVal;
      }
      return null;
    }

    function computeCategoryAvg(assessments, seat) {
      const key = String(seat);
      const vals = [];
      let absentCount = 0;

      for (const a of assessments) {
        const raw = a.scores[key];
        if (raw === "ABSENT") absentCount++;
        const norm = normalizeScoreValue(raw, a.maxScore);
        if (norm !== null) vals.push(norm);
      }

      if (vals.length === 0) {
        return { avg: null, count: 0, absentCount };
      }
      const sum = vals.reduce((acc, v) => acc + v, 0);
      return {
        avg: sum / vals.length,
        count: vals.length,
        absentCount,
      };
    }

    function computeStudentSubjectSummary(seat, subjectId) {
      const subjAssessments = state.assessments.filter((a) => a.subjectId === subjectId);
      const quizList = subjAssessments.filter((a) => a.category === "quiz");
      const midtermList = subjAssessments.filter((a) => a.category === "midterm");
      const finalList = subjAssessments.filter((a) => a.category === "final");

      const qRes = computeCategoryAvg(quizList, seat);
      const mRes = computeCategoryAvg(midtermList, seat);
      const fRes = computeCategoryAvg(finalList, seat);

      const absentCount = qRes.absentCount + mRes.absentCount + fRes.absentCount;
      const hasAnyScore = qRes.count > 0 || mRes.count > 0 || fRes.count > 0 || absentCount > 0;

      // 單純算術平均（不加權）：對已登錄的小考平均、期中考、期末考取平均
      const available = [qRes.avg, mRes.avg, fRes.avg].filter((v) => v !== null);
      const subjectAvg = available.length > 0 ? round1(available.reduce((s, v) => s + v, 0) / available.length) : null;

      return {
        seat: Number(seat),
        subjectId,
        quizAvg: round1(qRes.avg),
        quizCount: qRes.count,
        midtermAvg: round1(mRes.avg),
        finalAvg: round1(fRes.avg),
        subjectAvg,
        absentCount,
        hasAnyScore,
      };
    }

    function computeNumericStats(values) {
      const nums = values.filter((v) => v !== null && Number.isFinite(v));
      if (nums.length === 0) {
        return { count: 0, avg: null, max: null, min: null, passCount: 0, passRate: null };
      }
      const sum = nums.reduce((a, b) => a + b, 0);
      const passCount = nums.filter((v) => v >= 60).length;
      return {
        count: nums.length,
        avg: round1(sum / nums.length),
        max: round1(Math.max(...nums)),
        min: round1(Math.min(...nums)),
        passCount,
        passRate: round1((passCount / nums.length) * 100),
      };
    }

    function computeSubjectStats(subjectId) {
      const seats = getSeats().filter((s) => isSeatIncludedInStats(s));
      const assessments = getSubjectAssessments(subjectId);

      const perAssessment = {};
      for (const a of assessments) {
        const vals = [];
        let absentCount = 0;
        for (const s of seats) {
          const raw = a.scores[String(s)];
          if (raw === "ABSENT") absentCount++;
          const norm = normalizeScoreValue(raw, a.maxScore);
          if (norm !== null) vals.push(norm);
        }
        perAssessment[a.id] = {
          ...computeNumericStats(vals),
          absentCount,
        };
      }

      const summaries = seats.map((s) => computeStudentSubjectSummary(s, subjectId));
      const quizStats = computeNumericStats(summaries.map((x) => x.quizAvg));
      const midtermStats = computeNumericStats(summaries.map((x) => x.midtermAvg));
      const finalStats = computeNumericStats(summaries.map((x) => x.finalAvg));
      const subjectAvgStats = computeNumericStats(summaries.map((x) => x.subjectAvg));

      return {
        subjectId,
        includedSeatCount: seats.length,
        perAssessment,
        quizStats,
        midtermStats,
        finalStats,
        subjectAvgStats,
      };
    }

    function computeAllSubjectsOverview() {
      const seats = getSeats();
      const rows = seats.map((seat) => {
        const bySubject = {};
        const subjScores = [];
        let failedCount = 0;
        let absentTotal = 0;

        for (const subj of CFG.SUBJECTS) {
          const sum = computeStudentSubjectSummary(seat, subj.id);
          bySubject[subj.id] = sum;
          if (sum.subjectAvg !== null) {
            subjScores.push(sum.subjectAvg);
            if (sum.subjectAvg < 60) failedCount++;
          }
          absentTotal += sum.absentCount;
        }

        const overallAvg = subjScores.length
          ? round1(subjScores.reduce((a, b) => a + b, 0) / subjScores.length)
          : null;

        return {
          seat,
          name: getSeatName(seat, false),
          isTestSeat: isTestSeat(seat),
          isInactive: isInactiveSeat(seat),
          includedInStats: isSeatIncludedInStats(seat),
          bySubject,
          overallAvg,
          scoredSubjectCount: subjScores.length,
          failedCount,
          absentTotal,
          rank: null,
        };
      });

      const rankPool = rows
        .filter((r) => r.includedInStats && r.overallAvg !== null)
        .slice()
        .sort((a, b) => b.overallAvg - a.overallAvg);

      let prevScore = null;
      let prevRank = 0;
      rankPool.forEach((row, idx) => {
        if (prevScore !== null && row.overallAvg === prevScore) {
          row.rank = prevRank;
        } else {
          row.rank = idx + 1;
          prevRank = row.rank;
          prevScore = row.overallAvg;
        }
      });

      const subjectStats = {};
      for (const subj of CFG.SUBJECTS) {
        subjectStats[subj.id] = computeSubjectStats(subj.id);
      }

      const overallValues = rows
        .filter((r) => r.includedInStats && r.overallAvg !== null)
        .map((r) => r.overallAvg);

      return {
        rows,
        subjectStats,
        overallStats: computeNumericStats(overallValues),
      };
    }

    function savePreImportSnapshot(label = "匯入前自動備份") {
      if (!storage) return;
      try {
        storage.setItem(
          CFG.BACKUP_SNAPSHOT_KEY,
          JSON.stringify({
            label,
            savedAt: new Date().toISOString(),
            state,
          }),
        );
      } catch (err) {
        console.warn("建立匯入前快照失敗:", err);
      }
    }

    function getPreImportSnapshotMeta() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(CFG.BACKUP_SNAPSHOT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return { label: parsed.label, savedAt: parsed.savedAt };
      } catch (_) {
        return null;
      }
    }

    function restorePreImportSnapshot() {
      if (!storage || state.settings.studentHelperMode) return false;
      try {
        const raw = storage.getItem(CFG.BACKUP_SNAPSHOT_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.state) return false;
        state = normalizeState(parsed.state);
        persist();
        return true;
      } catch (err) {
        console.error("還原快照失敗:", err);
        return false;
      }
    }

    function applyImportOperations(operations, options = {}) {
      if (state.settings.studentHelperMode) {
        return { addedCount: 0, updatedCount: 0, skippedCount: operations.length, createdAssessments: 0 };
      }
      const { overwriteExisting = true, includeTestSeats = true } = options;
      savePreImportSnapshot("CSV 匯入前備份");

      let addedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      let createdAssessments = 0;
      const subjectsWithNewQuizzes = new Set();

      for (const op of operations) {
        const seat = clampSeat(op.seat, state.settings.maxSeat);
        if (!seat) {
          skippedCount++;
          continue;
        }
        if (!includeTestSeats && isTestSeat(seat)) {
          skippedCount++;
          continue;
        }

        let targetAssessment = null;
        if (op.assessmentId) {
          targetAssessment = state.assessments.find((a) => a.id === op.assessmentId);
        }
        if (!targetAssessment) {
          const titleClean = String(op.title || "").trim();
          targetAssessment = state.assessments.find(
            (a) => a.subjectId === op.subjectId && a.category === op.category && a.title === titleClean,
          );
        }
        if (targetAssessment && targetAssessment.locked) {
          skippedCount++;
          continue;
        }
        if (!targetAssessment) {
          const maxOrder = state.assessments.reduce((m, a) => Math.max(m, a.order || 0), 0);
          targetAssessment = {
            id: generateAssessmentId(op.subjectId, op.category),
            subjectId: op.subjectId,
            category: op.category,
            title: String(op.title || getNextDefaultTitle(op.subjectId, op.category)).slice(0, 60),
            date: String(op.date || "").slice(0, 20),
            maxScore: Number(op.maxScore) > 0 ? Number(op.maxScore) : 100,
            order: maxOrder + 1,
            locked: false,
            scores: {},
            notes: {},
          };
          state.assessments.push(targetAssessment);
          createdAssessments++;
        }
        if (op.category === "quiz" && targetAssessment.id !== `${op.subjectId}_quiz_1`) {
          subjectsWithNewQuizzes.add(op.subjectId);
        }

        const parsed = parseCellInput(op.value, targetAssessment.maxScore);
        if (!parsed.valid || parsed.value === null) {
          skippedCount++;
          continue;
        }

        const seatKey = String(seat);
        const prev = targetAssessment.scores[seatKey];
        if (prev !== undefined && !overwriteExisting) {
          skippedCount++;
          continue;
        }

        if (prev === undefined) {
          addedCount++;
        } else {
          updatedCount++;
        }
        targetAssessment.scores[seatKey] = parsed.value;

        if (typeof op.note === "string" && op.note.trim()) {
          targetAssessment.notes[seatKey] = op.note.trim().slice(0, 120);
        }
      }

      // 若匯入了新的具名小考欄位，順手清除尚未使用的空白預設「第1次小考」欄
      if (subjectsWithNewQuizzes.size > 0) {
        state.assessments = state.assessments.filter((a) => {
          if (
            subjectsWithNewQuizzes.has(a.subjectId) &&
            a.id === `${a.subjectId}_quiz_1` &&
            Object.keys(a.scores).length === 0 &&
            Object.keys(a.notes).length === 0
          ) {
            return false;
          }
          return true;
        });
      }

      persist();
      return { addedCount, updatedCount, skippedCount, createdAssessments };
    }

    function fillTestSeatDemoScores() {
      if (state.settings.studentHelperMode) return;
      const testSeats = state.settings.testSeats.length ? state.settings.testSeats : [29];
      const baseSamples = {
        chinese: { quiz: 88, midterm: 91, final: 94 },
        math: { quiz: 84, midterm: 87, final: 90 },
        integrated: { quiz: 92, midterm: 90, final: 93 },
        pe: { quiz: 95, midterm: 92, final: 96 },
        flexible: { quiz: 89, midterm: 88, final: 91 },
        school_based: { quiz: 90, midterm: 93, final: 95 },
      };

      for (const seat of testSeats) {
        const key = String(seat);
        for (const a of state.assessments) {
          if (a.locked) continue;
          const sample = baseSamples[a.subjectId]?.[a.category] ?? 88;
          a.scores[key] = Math.min(a.maxScore, sample);
        }
        if (!state.names[key]) {
          state.names[key] = "測試學生";
        }
      }
      persist();
    }

    function clearTestSeatScores() {
      if (state.settings.studentHelperMode) return;
      const testSeats = state.settings.testSeats.length ? state.settings.testSeats : [29];
      for (const seat of testSeats) {
        const key = String(seat);
        for (const a of state.assessments) {
          if (a.locked) continue;
          delete a.scores[key];
          delete a.notes[key];
        }
      }
      persist();
    }

    function loadClassDemoData() {
      if (state.settings.studentHelperMode) return;
      savePreImportSnapshot("載入示範資料前備份");
      const fresh = createDefaultState();
      fresh.settings = clone(state.settings);
      fresh.names = clone(state.names);

      fresh.assessments.splice(1, 0, {
        id: "chinese_quiz_2",
        subjectId: "chinese",
        category: "quiz",
        title: "第2次小考（聽寫）",
        date: "",
        maxScore: 100,
        order: 1.5,
        scores: {},
        notes: {},
      });
      fresh.assessments.splice(5, 0, {
        id: "math_quiz_2",
        subjectId: "math",
        category: "quiz",
        title: "第2次小考（單元二）",
        date: "",
        maxScore: 100,
        order: 4.5,
        scores: {},
        notes: {},
      });

      const surnamePool = ["陳", "林", "黃", "張", "李", "王", "吳", "劉", "蔡", "楊"];
      const givenPool = ["宇軒", "品妍", "子晴", "宥希", "承翰", "語彤", "柏睿", "恩熙", "宥辰", "欣妤"];

      for (let s = 1; s <= fresh.settings.maxSeat; s++) {
        const key = String(s);
        if (!fresh.names[key]) {
          fresh.names[key] = fresh.settings.testSeats.includes(s)
            ? "測試座號"
            : `${surnamePool[(s - 1) % surnamePool.length]}${givenPool[(s * 3) % givenPool.length]}`;
        }
        const ability = fresh.settings.testSeats.includes(s)
          ? 88
          : Math.max(54, Math.min(97, 74 + ((s * 11) % 23) - (s % 7 === 0 ? 16 : 0)));

        fresh.assessments.forEach((a, idx) => {
          if (s === 6 && idx === 1) {
            a.scores[key] = "ABSENT";
            return;
          }
          const jitter = ((s * 7 + idx * 13) % 15) - 6;
          a.scores[key] = Math.max(42, Math.min(100, Math.round(ability + jitter)));
        });
      }

      state = fresh;
      persist();
    }

    function resetAllData() {
      if (state.settings.studentHelperMode) return;
      savePreImportSnapshot("清空全部資料前備份");
      state = createDefaultState();
      persist();
    }

    function exportBackupJson() {
      return JSON.stringify(state, null, 2);
    }

    function importBackupJson(jsonText) {
      if (state.settings.studentHelperMode) {
        throw new Error("學生協助模式下無法還原備份");
      }
      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.assessments)) {
        throw new Error("JSON 格式不正確，缺少 assessments 欄位");
      }
      savePreImportSnapshot("JSON 還原前備份");
      state = normalizeState(parsed);
      persist();
      return state;
    }

    return {
      getState,
      getSeats,
      isTestSeat,
      isInactiveSeat,
      isSeatIncludedInStats,
      getSeatName,
      findSeatByName,
      parseRosterText,
      setNamesMap,
      updateSettings,
      setStudentHelperMode,
      getSubjectAssessments,
      getNextDefaultTitle,
      addAssessment,
      setAssessmentLocked,
      toggleAssessmentLock,
      updateAssessment,
      deleteAssessment,
      setScore,
      setNote,
      bulkAdjustAssessment,
      parseCellInput,
      normalizeScoreValue,
      computeStudentSubjectSummary,
      computeSubjectStats,
      computeAllSubjectsOverview,
      savePreImportSnapshot,
      getPreImportSnapshotMeta,
      restorePreImportSnapshot,
      applyImportOperations,
      fillTestSeatDemoScores,
      clearTestSeatScores,
      loadClassDemoData,
      resetAllData,
      exportBackupJson,
      importBackupJson,
      round1,
    };
  }

  const exported = {
    createStore,
    createDefaultState,
    parseCellInput,
    round1,
  };

  global.GradeStoreFactory = exported;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})(typeof window !== "undefined" ? window : globalThis);
