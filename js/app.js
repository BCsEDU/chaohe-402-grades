// 學生成績管理系統前端互動控制器（簡潔清楚版）
(function () {
  const CFG = window.GRADE_CONFIG;
  const store = window.GradeStoreFactory.createStore();
  const csv = window.GradeCsv;

  const ui = {
    activeTab: "entry",
    activeSubjectId: CFG.SUBJECTS[0].id,
    activeCategoryFilter: "all",
    overviewMetric: "subjectAvg",
    overviewOnlyAlert: false,
    importState: null,
    undoMessage: "",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function isHelperMode() {
    return Boolean(store.getState().settings.studentHelperMode);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getSubject(id) {
    return CFG.SUBJECTS.find((s) => s.id === id) || CFG.SUBJECTS[0];
  }

  function getCategory(id) {
    return CFG.CATEGORIES.find((c) => c.id === id) || CFG.CATEGORIES[0];
  }

  function showToast(msg, type = "default") {
    const container = $("toast-container");
    const el = document.createElement("div");
    el.className = `toast ${type === "ok" ? "toast-ok" : type === "err" ? "toast-err" : ""}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function downloadTextFile(filename, content, mimeType = "text/csv;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatCellValueForInput(rawVal) {
    if (rawVal === undefined || rawVal === null) return "";
    if (rawVal === "ABSENT") return "缺考";
    if (rawVal === "EXEMPT") return "免考";
    return String(rawVal);
  }

  function getCellInputClass(rawVal, maxScore = 100) {
    if (rawVal === "ABSENT") return "score-input is-absent";
    if (rawVal === "EXEMPT") return "score-input is-exempt";
    if (typeof rawVal === "number") {
      const pct = maxScore > 0 ? (rawVal / maxScore) * 100 : rawVal;
      if (pct >= 90) return "score-input is-high";
      if (pct < 60) return "score-input is-fail";
    }
    return "score-input";
  }

  function renderHeader() {
    const st = store.getState().settings;
    const helper = Boolean(st.studentHelperMode);

    $("hdr-class-badge").textContent = st.className;
    const testLabel = st.testSeats.length ? `${st.testSeats.join("、")} 號為測試座號` : "無測試座號";
    $("hdr-seat-badge").textContent = `1~${st.maxSeat} 號（${testLabel}）`;
    $("hdr-semester-sub").textContent = helper
      ? `${st.semesterName} · 學生協助登打模式`
      : `${st.semesterName} · 本機即時儲存`;

    $("helper-mode-banner").classList.toggle("hidden", !helper);
    $("tabs-wrap").classList.toggle("hidden", helper);
    $("btn-enter-helper-mode").classList.toggle("hidden", helper);
    $("btn-toggle-privacy").classList.toggle("hidden", helper);
    $("btn-quick-import").classList.toggle("hidden", helper);
    $("btn-quick-export").classList.toggle("hidden", helper);

    const privBtn = $("btn-toggle-privacy");
    if (st.hideNames) {
      privBtn.textContent = "👁️ 顯示姓名";
      privBtn.classList.add("is-active");
    } else {
      privBtn.textContent = "👁️ 隱藏姓名";
      privBtn.classList.remove("is-active");
    }

    const undoMeta = store.getPreImportSnapshotMeta();
    const banner = $("global-undo-banner");
    if (!helper && ui.undoMessage && undoMeta) {
      $("global-undo-text").textContent = ui.undoMessage;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function switchTab(tabName) {
    if (isHelperMode() && tabName !== "entry") {
      tabName = "entry";
    }
    ui.activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
    });
    renderActiveTab();
  }

  function renderActiveTab() {
    if (isHelperMode()) {
      ui.activeTab = "entry";
      ui.activeCategoryFilter = "all";
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("hidden", panel.id !== "tab-entry");
      });
    }
    renderHeader();
    if (ui.activeTab === "entry") renderEntryTab();
    else if (ui.activeTab === "overview") renderOverviewTab();
    else if (ui.activeTab === "import") renderImportTab();
    else if (ui.activeTab === "export") renderExportTab();
    else if (ui.activeTab === "settings") renderSettingsTab();
  }

  // ==========================================
  // 表格欄位結構計算（避免重複欄位，清楚好輸入）
  // ==========================================
  function getEntryTableLayout(subjectId, categoryFilter) {
    const allAssessments = store.getSubjectAssessments(subjectId, categoryFilter);
    const quizzes = allAssessments.filter((a) => a.category === "quiz");
    const midterms = allAssessments.filter((a) => a.category === "midterm");
    const finals = allAssessments.filter((a) => a.category === "final");

    const columns = [];
    quizzes.forEach((a) => columns.push({ type: "assessment", assessment: a }));
    if (quizzes.length > 0 && (categoryFilter === "all" || categoryFilter === "quiz")) {
      columns.push({ type: "summary", key: "quizAvg", label: "小考平均" });
    }

    midterms.forEach((a) => columns.push({ type: "assessment", assessment: a }));
    if (midterms.length > 1) {
      columns.push({ type: "summary", key: "midtermAvg", label: "期中平均" });
    }

    finals.forEach((a) => columns.push({ type: "assessment", assessment: a }));
    if (finals.length > 1) {
      columns.push({ type: "summary", key: "finalAvg", label: "期末平均" });
    }

    if (categoryFilter === "all") {
      columns.push({ type: "summary", key: "subjectAvg", label: "科目平均", highlight: true });
    }

    let inputIdx = 0;
    for (const col of columns) {
      if (col.type === "assessment") {
        col.inputColIdx = inputIdx++;
      }
    }
    return columns;
  }

  // ==========================================
  // 分頁 1：單科成績登錄工作台
  // ==========================================
  function renderEntryTab() {
    const state = store.getState();
    const subj = getSubject(ui.activeSubjectId);
    const helper = isHelperMode();

    $("subject-pills").innerHTML = CFG.SUBJECTS.map((s) => {
      const assessments = store.getSubjectAssessments(s.id);
      const includedSeats = store.getSeats().filter((seat) => store.isSeatIncludedInStats(seat));
      let scoredSeats = 0;
      for (const seat of includedSeats) {
        if (assessments.some((a) => a.scores[String(seat)] !== undefined)) scoredSeats++;
      }
      const isActive = s.id === ui.activeSubjectId;
      return `
        <button
          type="button"
          class="subject-pill ${isActive ? "active" : ""}"
          data-subject-id="${s.id}"
          style="--subj-color:${s.color}; --subj-bg:${s.bg};"
        >
          <span class="subj-dot"></span>
          <span>${escapeHtml(s.name)}</span>
          ${helper ? "" : `<span class="subj-count">${scoredSeats}/${includedSeats.length}</span>`}
        </button>
      `;
    }).join("");

    $("category-filter").classList.toggle("hidden", helper);
    $("btn-fill-test-seat").classList.toggle("hidden", helper);
    $("wrap-include-test-stats").classList.toggle("hidden", helper);
    $("btn-export-current-subject").classList.toggle("hidden", helper);
    $("entry-stats-strip").classList.toggle("hidden", helper);

    $("entry-table-hint").innerHTML = helper
      ? '操作說明：請選擇科目、點 <strong>＋ 新增小考／評量</strong>，再於未鎖定欄位輸入成績（按 <kbd>Enter</kbd> 跳下一號；輸入 <code>缺</code>=缺考、<code>免</code>=免考）'
      : '按 <kbd>Enter</kbd> / <kbd>↓</kbd> 跳下一號；輸入 <code>缺</code>=缺考、<code>免</code>=免考；點 🔓 可鎖定直欄防誤觸';

    document.querySelectorAll("#category-filter .seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.cat === ui.activeCategoryFilter);
    });

    $("chk-include-test-stats").checked = Boolean(state.settings.includeTestInStats);
    $("entry-table-title").textContent = `${subj.name}成績表`;

    if (!helper) renderEntryStatsStrip();
    renderEntryTable();
  }

  function renderEntryStatsStrip() {
    const stats = store.computeSubjectStats(ui.activeSubjectId);
    const st = store.getState().settings;
    const allSeats = store.getSeats().filter((s) => store.isSeatIncludedInStats(s));
    const summaries = allSeats.map((s) => store.computeStudentSubjectSummary(s, ui.activeSubjectId));
    const failCount = summaries.filter((x) => x.subjectAvg !== null && x.subjectAvg < 60).length;
    const absentTotal = summaries.reduce((acc, x) => acc + x.absentCount, 0);

    const scopeText = st.includeTestInStats ? "含29號測試" : "不含29號測試";
    $("entry-stats-strip").innerHTML = `
      <span class="stat-chip">科目平均 <strong>${stats.subjectAvgStats.avg ?? "—"}</strong></span>
      <span class="stat-chip">小考均 <strong>${stats.quizStats.avg ?? "—"}</strong></span>
      <span class="stat-chip">期中 <strong>${stats.midtermStats.avg ?? "—"}</strong></span>
      <span class="stat-chip">期末 <strong>${stats.finalStats.avg ?? "—"}</strong></span>
      <span class="stat-chip">及格率 <strong>${stats.subjectAvgStats.passRate !== null ? `${stats.subjectAvgStats.passRate}%` : "—"}</strong></span>
      ${failCount > 0 ? `<span class="stat-chip" style="color:var(--bad);background:var(--bad-tint);">不及格 <strong>${failCount} 人</strong></span>` : ""}
      ${absentTotal > 0 ? `<span class="stat-chip" style="color:var(--warn);background:var(--warn-tint);">缺考 <strong>${absentTotal} 筆</strong></span>` : ""}
      <span class="section-hint">（${scopeText}）</span>
    `;
  }

  function renderEntryTable() {
    const state = store.getState();
    const helper = isHelperMode();
    const hideNames = helper ? true : state.settings.hideNames;
    const columns = getEntryTableLayout(ui.activeSubjectId, ui.activeCategoryFilter);
    const stats = store.computeSubjectStats(ui.activeSubjectId);
    const seats = store.getSeats();

    const headerCells = columns
      .map((col) => {
        if (col.type === "summary") {
          return `<th>${escapeHtml(col.label)}</th>`;
        }
        const a = col.assessment;
        const cat = getCategory(a.category);
        const st = stats.perAssessment[a.id];
        const subText = helper
          ? a.maxScore !== 100
            ? `滿分 ${a.maxScore}`
            : a.locked
              ? "已鎖定"
              : "可輸入"
          : st && st.count > 0
            ? `均 ${st.avg} · ${st.count}人`
            : a.maxScore !== 100
              ? `滿分 ${a.maxScore}`
              : "點擊編輯";

        const lockBtnTitle = helper
          ? a.locked
            ? "此欄位已被教師鎖定"
            : "學生協助模式無法更改鎖定狀態"
          : a.locked
            ? "點擊解除鎖定"
            : "點擊鎖定此直欄，防止誤觸修改";

        return `
          <th class="${a.locked ? "th-col-locked" : ""}">
            <div class="th-assessment-wrap">
              <div class="th-top-row">
                <span class="col-cat-tag" style="color:${cat.color};background:${cat.bg};">${escapeHtml(cat.name)}</span>
                <button
                  type="button"
                  class="col-lock-btn ${a.locked ? "is-locked" : ""}"
                  data-toggle-lock="${escapeHtml(a.id)}"
                  ${helper ? "disabled" : ""}
                  title="${escapeHtml(lockBtnTitle)}"
                >${a.locked ? "🔒 已鎖定" : "🔓"}</button>
              </div>
              <button
                type="button"
                class="col-header-btn"
                data-edit-assessment="${escapeHtml(a.id)}"
                ${helper ? "disabled" : ""}
                title="${helper ? escapeHtml(a.title) : "點擊重新命名、調分或刪除"}"
              >
                <span class="col-title-text">${escapeHtml(a.title)}</span>
                <span class="col-sub-stat" data-col-stat="${escapeHtml(a.id)}">${escapeHtml(subText)}</span>
              </button>
            </div>
          </th>
        `;
      })
      .join("");

    const theadHtml = `
      <thead>
        <tr>
          <th class="sticky-col-1">座號</th>
          ${hideNames ? "" : '<th class="sticky-col-2">姓名</th>'}
          ${headerCells}
        </tr>
      </thead>
    `;

    const bodyRowsHtml = seats
      .map((seat) => {
        const isTest = store.isTestSeat(seat);
        const isInactive = store.isInactiveSeat(seat);
        const name = store.getSeatName(seat, true);
        const sum = store.computeStudentSubjectSummary(seat, ui.activeSubjectId);

        const rowClass = [
          isTest ? "row-test-seat" : "",
          isInactive ? "row-inactive" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const seatBadge = isTest
          ? `<span class="badge badge-test" title="測試座號預設不計入班級統計">測試</span>`
          : isInactive
            ? `<span class="badge badge-inactive">空號</span>`
            : "";

        const dataCells = columns
          .map((col) => {
            if (col.type === "summary") {
              const val = sum[col.key];
              const cls = col.highlight
                ? `weighted-cell ${val !== null ? (val >= 90 ? "score-text-ok" : val < 60 ? "score-text-bad" : "") : ""}`
                : "summary-cell";
              return `<td class="${cls}" data-sum-cell="${seat}-${col.key}">${val ?? "—"}</td>`;
            }
            const a = col.assessment;
            const rawVal = a.scores[String(seat)];
            const noteText = a.notes[String(seat)] || "";
            const cls = `${getCellInputClass(rawVal, a.maxScore)}${a.locked ? " is-locked" : ""}`;
            const disp = formatCellValueForInput(rawVal);
            return `
              <td class="${a.locked ? "td-col-locked" : ""}">
                <div class="score-cell-wrap">
                  <input
                    type="text"
                    class="${cls}"
                    data-seat="${seat}"
                    data-assessment-id="${escapeHtml(a.id)}"
                    data-col-idx="${col.inputColIdx}"
                    value="${escapeHtml(disp)}"
                    placeholder="—"
                    ${a.locked ? "disabled" : ""}
                    aria-label="座號 ${seat} ${escapeHtml(a.title)}"
                  />
                  ${
                    helper || a.locked
                      ? ""
                      : `<button
                          type="button"
                          class="note-dot-btn ${noteText ? "has-note" : ""}"
                          data-note-seat="${seat}"
                          data-note-aid="${escapeHtml(a.id)}"
                          title="${noteText ? escapeHtml(noteText) : "新增備註"}"
                        >${noteText ? "📝" : "◦"}</button>`
                  }
                </div>
              </td>
            `;
          })
          .join("");

        return `
          <tr class="${rowClass}" data-seat-row="${seat}">
            <td class="sticky-col-1"><strong>${seat}</strong> ${seatBadge}</td>
            ${
              hideNames
                ? ""
                : `<td class="sticky-col-2">${name ? escapeHtml(name) : isTest ? '<span class="section-hint">測試座號</span>' : '<span class="section-hint">—</span>'}</td>`
            }
            ${dataCells}
          </tr>
        `;
      })
      .join("");

    const tfootHtml = helper ? "" : `<tfoot>${buildEntryTfootHtml(columns, stats, hideNames)}</tfoot>`;
    $("grade-entry-table").innerHTML = `${theadHtml}<tbody>${bodyRowsHtml}</tbody>${tfootHtml}`;
  }

  function getColumnStatObj(col, stats) {
    if (col.type === "assessment") return stats.perAssessment[col.assessment.id];
    if (col.key === "quizAvg") return stats.quizStats;
    if (col.key === "midtermAvg") return stats.midtermStats;
    if (col.key === "finalAvg") return stats.finalStats;
    return stats.subjectAvgStats;
  }

  function buildEntryTfootHtml(columns, stats, hideNames) {
    const labelSuffix = store.getState().settings.includeTestInStats ? "（含測試）" : "（不含測試）";
    const avgCells = columns.map((c) => `<td>${getColumnStatObj(c, stats)?.avg ?? "—"}</td>`).join("");
    const passCells = columns
      .map((c) => {
        const s = getColumnStatObj(c, stats);
        return `<td>${s?.passRate !== null && s?.passRate !== undefined ? `${s.passRate}%` : "—"}</td>`;
      })
      .join("");

    return `
      <tr>
        <td class="sticky-col-1">班級平均</td>
        ${hideNames ? "" : `<td class="sticky-col-2"><span class="section-hint">${labelSuffix}</span></td>`}
        ${avgCells}
      </tr>
      <tr>
        <td class="sticky-col-1">及格率</td>
        ${hideNames ? "" : '<td class="sticky-col-2"><span class="section-hint">≥ 60 分</span></td>'}
        ${passCells}
      </tr>
    `;
  }

  function updateEntryRowAndStatsIncremental(seat, assessmentId) {
    const sum = store.computeStudentSubjectSummary(seat, ui.activeSubjectId);
    for (const key of ["quizAvg", "midtermAvg", "finalAvg", "subjectAvg"]) {
      const cell = document.querySelector(`[data-sum-cell="${seat}-${key}"]`);
      if (!cell) continue;
      const val = sum[key];
      cell.textContent = val ?? "—";
      if (key === "subjectAvg") {
        cell.className = `weighted-cell ${val !== null ? (val >= 90 ? "score-text-ok" : val < 60 ? "score-text-bad" : "") : ""}`;
      }
    }

    const helper = isHelperMode();
    const columns = getEntryTableLayout(ui.activeSubjectId, ui.activeCategoryFilter);
    const stats = store.computeSubjectStats(ui.activeSubjectId);
    const colStatEl = document.querySelector(`[data-col-stat="${CSS.escape(assessmentId)}"]`);
    if (colStatEl && !helper) {
      const st = stats.perAssessment[assessmentId];
      colStatEl.textContent = st && st.count > 0 ? `均 ${st.avg} · ${st.count}人` : "點擊編輯";
    }

    if (!helper) {
      const tfoot = document.querySelector("#grade-entry-table tfoot");
      if (tfoot) {
        tfoot.innerHTML = buildEntryTfootHtml(columns, stats, store.getState().settings.hideNames);
      }
      renderEntryStatsStrip();
      renderSubjectPillCounts();
    }
  }

  function renderSubjectPillCounts() {
    document.querySelectorAll(".subject-pill").forEach((btn) => {
      const sid = btn.dataset.subjectId;
      const assessments = store.getSubjectAssessments(sid);
      const includedSeats = store.getSeats().filter((seat) => store.isSeatIncludedInStats(seat));
      let scoredSeats = 0;
      for (const seat of includedSeats) {
        if (assessments.some((a) => a.scores[String(seat)] !== undefined)) scoredSeats++;
      }
      const countSpan = btn.querySelector(".subj-count");
      if (countSpan) countSpan.textContent = `${scoredSeats}/${includedSeats.length}`;
    });
  }

  function handleEntryCellCommit(inputEl) {
    const seat = Number(inputEl.dataset.seat);
    const aid = inputEl.dataset.assessmentId;
    const item = store.getState().assessments.find((a) => a.id === aid);
    if (!item) return true;

    const result = store.setScore(aid, seat, inputEl.value);
    if (!result.valid) {
      inputEl.classList.add("is-invalid");
      showToast(result.error, "err");
      return false;
    }

    inputEl.className = `${getCellInputClass(result.value, item.maxScore)}${item.locked ? " is-locked" : ""}`;
    inputEl.value = formatCellValueForInput(result.value);
    updateEntryRowAndStatsIncremental(seat, aid);
    return true;
  }

  function moveEntryFocus(currentInput, rowDelta, colDelta) {
    const table = $("grade-entry-table");
    const seat = Number(currentInput.dataset.seat);
    let colIdx = Number(currentInput.dataset.colIdx);

    if (colDelta !== 0) {
      for (let step = 1; step <= 40; step++) {
        const candidate = table.querySelector(
          `input.score-input[data-seat="${seat}"][data-col-idx="${colIdx + colDelta * step}"]`,
        );
        if (!candidate) break;
        if (!candidate.disabled) {
          candidate.focus();
          candidate.select();
          return;
        }
      }
      return;
    }

    const next = table.querySelector(
      `input.score-input[data-seat="${seat + rowDelta}"][data-col-idx="${colIdx}"]`,
    );
    if (next && !next.disabled) {
      next.focus();
      next.select();
    }
  }

  // ==========================================
  // 分頁 2：全科總覽
  // ==========================================
  function renderOverviewTab() {
    const state = store.getState();
    const hideNames = state.settings.hideNames;
    const overview = store.computeAllSubjectsOverview();
    const metric = ui.overviewMetric;

    document.querySelectorAll("#overview-metric-tabs .seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.metric === metric);
    });
    $("chk-overview-only-alert").checked = ui.overviewOnlyAlert;

    const includedRows = overview.rows.filter((r) => r.includedInStats);
    const needAlertRows = includedRows.filter((r) => r.failedCount > 0 || r.absentTotal > 0);
    const passAllCount = includedRows.filter((r) => r.scoredSubjectCount > 0 && r.failedCount === 0).length;

    $("overview-stats-strip").innerHTML = `
      <span class="stat-chip">全班總平均 <strong>${overview.overallStats.avg ?? "—"}</strong></span>
      <span class="stat-chip">全科及格 <strong>${passAllCount}/${overview.overallStats.count} 人</strong></span>
      ${needAlertRows.length > 0 ? `<span class="stat-chip" style="color:var(--bad);background:var(--bad-tint);">需關注 <strong>${needAlertRows.length} 人</strong></span>` : ""}
      <span class="section-hint">（${state.settings.includeTestInStats ? "含29號測試" : "已排除29號測試座號"}）</span>
    `;

    const displayRows = ui.overviewOnlyAlert
      ? overview.rows.filter((r) => r.failedCount > 0 || r.absentTotal > 0)
      : overview.rows;

    const thead = `
      <thead>
        <tr>
          <th class="sticky-col-1">座號</th>
          ${hideNames ? "" : '<th class="sticky-col-2">姓名</th>'}
          ${CFG.SUBJECTS.map((s) => `<th>${escapeHtml(s.name)}</th>`).join("")}
          <th>總平均</th>
          <th>參考排名</th>
          <th>提醒</th>
        </tr>
      </thead>
    `;

    const tbodyRows = displayRows
      .map((r) => {
        const rowClass = [
          "clickable-row",
          r.isTestSeat ? "row-test-seat" : "",
          r.isInactive ? "row-inactive" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const seatBadge = r.isTestSeat ? '<span class="badge badge-test">測試</span>' : "";
        const subjCells = CFG.SUBJECTS.map((subj) => {
          const sum = r.bySubject[subj.id];
          const val =
            metric === "quiz"
              ? sum.quizAvg
              : metric === "midterm"
                ? sum.midtermAvg
                : metric === "final"
                  ? sum.finalAvg
                  : sum.subjectAvg;
          const cls = val === null ? "" : val >= 90 ? "score-text-ok" : val < 60 ? "score-text-bad" : "";
          return `<td class="${cls}" style="font-weight:600;">${val ?? "—"}</td>`;
        }).join("");

        const alertBadges = [];
        if (r.failedCount > 0) alertBadges.push(`<span class="badge badge-bad">${r.failedCount}科&lt;60</span>`);
        if (r.absentTotal > 0) alertBadges.push(`<span class="badge badge-warn">缺${r.absentTotal}</span>`);

        return `
          <tr class="${rowClass}" data-student-detail="${r.seat}" title="點擊查看座號 ${r.seat} 詳細分數">
            <td class="sticky-col-1"><strong>${r.seat}</strong> ${seatBadge}</td>
            ${
              hideNames
                ? ""
                : `<td class="sticky-col-2">${r.name ? escapeHtml(r.name) : r.isTestSeat ? '<span class="section-hint">測試座號</span>' : "—"}</td>`
            }
            ${subjCells}
            <td style="font-weight:700;">${r.overallAvg ?? "—"}</td>
            <td>${r.isTestSeat ? '<span class="badge badge-test">不計名</span>' : (r.rank ?? "—")}</td>
            <td>${alertBadges.join(" ") || '<span class="section-hint">—</span>'}</td>
          </tr>
        `;
      })
      .join("");

    const tfoot = `
      <tfoot>
        <tr>
          <td class="sticky-col-1">班級平均</td>
          ${hideNames ? "" : '<td class="sticky-col-2"><span class="section-hint">全班平均</span></td>'}
          ${CFG.SUBJECTS.map((subj) => {
            const st = overview.subjectStats[subj.id];
            const val =
              metric === "quiz"
                ? st.quizStats.avg
                : metric === "midterm"
                  ? st.midtermStats.avg
                  : metric === "final"
                    ? st.finalStats.avg
                    : st.subjectAvgStats.avg;
            return `<td>${val ?? "—"}</td>`;
          }).join("")}
          <td>${overview.overallStats.avg ?? "—"}</td>
          <td>—</td>
          <td>—</td>
        </tr>
      </tfoot>
    `;

    $("overview-table").innerHTML = `${thead}<tbody>${tbodyRows}</tbody>${tfoot}`;
  }

  // ==========================================
  // 分頁 3：CSV 快速上傳
  // ==========================================
  function renderImportTab() {
    const previewCard = $("import-preview-card");
    if (!ui.importState) {
      previewCard.classList.add("hidden");
      return;
    }

    const { analysis, encoding, delimiter, config } = ui.importState;
    previewCard.classList.remove("hidden");

    if (analysis.error) {
      $("import-meta-badges").innerHTML = `<span class="badge badge-bad">${escapeHtml(analysis.error)}</span>`;
      $("import-twocol-config").classList.add("hidden");
      $("import-wide-config").classList.add("hidden");
      $("import-summary-pills").innerHTML = "";
      $("import-warnings-box").classList.add("hidden");
      $("import-diff-table").innerHTML = "";
      $("btn-commit-import").disabled = true;
      return;
    }

    $("import-meta-badges").innerHTML = `
      <span class="badge badge-blue">編碼：${escapeHtml(encoding)}</span>
      <span class="badge badge-neutral">分隔：${escapeHtml(delimiter)}</span>
      <span class="badge badge-ok">識別模式：${escapeHtml(analysis.modeLabel)}</span>
      <span class="badge badge-neutral">資料列數：${analysis.dataRows.length}</span>
    `;

    const twoColBox = $("import-twocol-config");
    const wideBox = $("import-wide-config");

    if (analysis.mode === "two_col") {
      twoColBox.classList.remove("hidden");
      wideBox.classList.add("hidden");
      renderTwoColImportControls(config);
    } else if (analysis.mode === "wide") {
      twoColBox.classList.add("hidden");
      wideBox.classList.remove("hidden");
      renderWideImportControls(config);
    } else {
      twoColBox.classList.add("hidden");
      wideBox.classList.add("hidden");
    }

    $("chk-imp-overwrite").checked = config.overwriteExisting;
    $("chk-imp-include-test").checked = config.includeTestSeats;

    const preview = csv.buildImportPreview(analysis, store, config);
    ui.importState.lastPreview = preview;

    const { stats, warnings, operations } = preview;
    const subjNames = stats.affectedSubjects.map((id) => getSubject(id).name).join("、") || "無";
    $("import-summary-pills").innerHTML = `
      <span class="badge badge-blue">預計寫入：${stats.totalOps} 筆（${escapeHtml(subjNames)}）</span>
      <span class="badge badge-ok">新增：${stats.addCount} 筆</span>
      <span class="badge badge-warn">覆蓋：${stats.updateCount} 筆</span>
      <span class="badge badge-neutral">相同：${stats.unchangedCount} 筆</span>
      ${stats.testSeatCount > 0 ? `<span class="badge badge-test">含 29 號測試座號：${stats.testSeatCount} 筆</span>` : ""}
    `;

    const warnBox = $("import-warnings-box");
    if (warnings.length > 0) {
      const items = warnings.slice(0, 12).map((w) => `<li>第 ${w.rowNum} 列：${escapeHtml(w.message)}</li>`).join("");
      const more = warnings.length > 12 ? `<li>…另有 ${warnings.length - 12} 筆警告</li>` : "";
      warnBox.innerHTML = `<strong>⚠️ 偵測到 ${warnings.length} 筆異常資料（將自動略過）：</strong><ul>${items}${more}</ul>`;
      warnBox.classList.remove("hidden");
    } else {
      warnBox.classList.add("hidden");
    }

    const previewRows = operations.slice(0, 120);
    const diffThead = `
      <thead>
        <tr>
          <th>座號</th>
          <th>科目</th>
          <th>類別</th>
          <th>評量名稱</th>
          <th>原成績</th>
          <th>新成績</th>
          <th>狀態</th>
        </tr>
      </thead>
    `;
    const diffTbody = previewRows
      .map((op) => {
        const subj = getSubject(op.subjectId);
        const cat = getCategory(op.category);
        const statusBadge =
          op.changeType === "add"
            ? '<span class="badge badge-ok">新增</span>'
            : op.changeType === "update"
              ? '<span class="badge badge-warn">覆蓋</span>'
              : '<span class="badge badge-neutral">相同</span>';
        return `
          <tr class="${op.isTestSeat ? "row-test-seat" : ""}">
            <td><strong>${op.seat}</strong> ${op.isTestSeat ? '<span class="badge badge-test">測試</span>' : ""}</td>
            <td>${escapeHtml(subj.name)}</td>
            <td>${escapeHtml(cat.name)}</td>
            <td>${escapeHtml(op.title)}</td>
            <td>${escapeHtml(csv.formatRawScoreForDisplay(op.oldValue))}</td>
            <td><strong>${escapeHtml(csv.formatRawScoreForDisplay(op.value))}</strong></td>
            <td>${statusBadge}</td>
          </tr>
        `;
      })
      .join("");

    const emptyNotice =
      operations.length === 0
        ? '<tr><td colspan="7" class="section-hint">沒有可匯入的有效成績。</td></tr>'
        : operations.length > 120
          ? `<tr><td colspan="7" class="section-hint">僅預覽前 120 筆，確認匯入將處理全部 ${operations.length} 筆。</td></tr>`
          : "";

    $("import-diff-table").innerHTML = `${diffThead}<tbody>${diffTbody}${emptyNotice}</tbody>`;

    const commitBtn = $("btn-commit-import");
    commitBtn.disabled = operations.length === 0;
    commitBtn.textContent = `確認匯入 ${operations.length} 筆成績`;
  }

  function renderTwoColImportControls(config) {
    $("imp-target-subject").innerHTML = CFG.SUBJECTS.map(
      (s) => `<option value="${s.id}" ${s.id === config.targetSubjectId ? "selected" : ""}>${escapeHtml(s.name)}</option>`,
    ).join("");

    $("imp-target-category").innerHTML = CFG.CATEGORIES.map(
      (c) => `<option value="${c.id}" ${c.id === config.targetCategory ? "selected" : ""}>${escapeHtml(c.name)}</option>`,
    ).join("");

    const assessments = store.getSubjectAssessments(config.targetSubjectId, config.targetCategory);
    const assessSel = $("imp-target-assessment");
    const optionsHtml = assessments
      .map(
        (a) =>
          `<option value="${escapeHtml(a.id)}" ${config.targetAssessmentId === a.id ? "selected" : ""}>覆寫／補齊：${escapeHtml(a.title)}</option>`,
      )
      .join("");
    assessSel.innerHTML = `${optionsHtml}<option value="__NEW__" ${config.targetAssessmentId === "__NEW__" ? "selected" : ""}>＋ 建立新評量欄位</option>`;

    if (
      config.targetAssessmentId !== "__NEW__" &&
      !assessments.some((a) => a.id === config.targetAssessmentId)
    ) {
      config.targetAssessmentId = assessments[0] ? assessments[0].id : "__NEW__";
      assessSel.value = config.targetAssessmentId;
    }

    const newWrap = $("imp-new-title-wrap");
    if (config.targetAssessmentId === "__NEW__") {
      newWrap.classList.remove("hidden");
      if (!$("imp-new-title").value.trim() && config.targetTitle) {
        $("imp-new-title").value = config.targetTitle;
      }
    } else {
      newWrap.classList.add("hidden");
    }
  }

  function renderWideImportControls(config) {
    $("imp-wide-default-subject").innerHTML = CFG.SUBJECTS.map(
      (s) => `<option value="${s.id}" ${s.id === config.wideDefaultSubjectId ? "selected" : ""}>${escapeHtml(s.name)}</option>`,
    ).join("");

    const mappings = config.columnMappings;
    const thead = `
      <thead>
        <tr>
          <th>CSV 原欄名</th>
          <th>處理方式</th>
          <th>對應科目</th>
          <th>成績類別</th>
          <th>評量名稱</th>
        </tr>
      </thead>
    `;

    const tbody = mappings
      .map((m, idx) => {
        if (m.role !== "score") {
          return `
            <tr>
              <td><strong>${escapeHtml(m.header)}</strong></td>
              <td colspan="4"><span class="badge badge-neutral">${m.role === "seat" ? "座號識別欄" : "姓名對照欄"}</span></td>
            </tr>
          `;
        }
        const disabled = m.action === "ignore" ? "disabled" : "";
        return `
          <tr>
            <td><strong>${escapeHtml(m.header)}</strong></td>
            <td>
              <select class="input-select" data-wide-map-idx="${idx}" data-wide-field="action">
                <option value="import" ${m.action === "import" ? "selected" : ""}>匯入成績</option>
                <option value="ignore" ${m.action === "ignore" ? "selected" : ""}>略過此欄</option>
              </select>
            </td>
            <td>
              <select class="input-select" data-wide-map-idx="${idx}" data-wide-field="subjectId" ${disabled}>
                ${CFG.SUBJECTS.map((s) => `<option value="${s.id}" ${s.id === m.subjectId ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
              </select>
            </td>
            <td>
              <select class="input-select" data-wide-map-idx="${idx}" data-wide-field="category" ${disabled}>
                ${CFG.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === m.category ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
              </select>
            </td>
            <td>
              <input type="text" class="input-text" data-wide-map-idx="${idx}" data-wide-field="title" value="${escapeHtml(m.title)}" ${disabled} />
            </td>
          </tr>
        `;
      })
      .join("");

    $("imp-wide-mapping-table").innerHTML = `${thead}<tbody>${tbody}</tbody>`;
  }

  function startImportFromText(rawText, meta = {}) {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) {
      ui.importState = null;
      renderImportTab();
      return;
    }

    const parsed = csv.parseDelimitedText(trimmed);
    const analysis = csv.analyzeCsvRows(parsed.rows, store, {
      defaultSubjectId: ui.activeSubjectId,
    });

    const targetSubjectId = analysis.suggestedSubjectId || ui.activeSubjectId;
    const targetCategory = analysis.suggestedCategory || "quiz";
    const existingAssessments = store.getSubjectAssessments(targetSubjectId, targetCategory);

    let targetAssessmentId = existingAssessments[0] ? existingAssessments[0].id : "__NEW__";
    const targetTitle = analysis.suggestedTitle || "";
    if (analysis.suggestedTitle) {
      const exactHit = existingAssessments.find((a) => a.title === analysis.suggestedTitle);
      targetAssessmentId = exactHit ? exactHit.id : "__NEW__";
    }

    ui.importState = {
      rawText: trimmed,
      encoding: meta.encoding || "文字貼上",
      delimiter: parsed.delimiter,
      analysis,
      config: {
        targetSubjectId,
        targetCategory,
        targetAssessmentId,
        targetTitle,
        wideDefaultSubjectId: ui.activeSubjectId,
        columnMappings: analysis.columnMappings ? JSON.parse(JSON.stringify(analysis.columnMappings)) : [],
        overwriteExisting: true,
        includeTestSeats: true,
      },
    };

    $("imp-new-title").value = targetTitle;
    renderImportTab();
  }

  // ==========================================
  // 分頁 4：CSV 匯出
  // ==========================================
  function renderExportTab() {
    const sel = $("exp-subject-select");
    const prev = sel.value || ui.activeSubjectId;
    sel.innerHTML = CFG.SUBJECTS.map(
      (s) => `<option value="${s.id}" ${s.id === prev ? "selected" : ""}>${escapeHtml(s.name)}</option>`,
    ).join("");
  }

  function getExportOptionsFromUi() {
    return {
      includeTestSeats: $("chk-exp-include-test") ? $("chk-exp-include-test").checked : true,
      includeNames: $("chk-exp-include-names") ? $("chk-exp-include-names").checked : !store.getState().settings.hideNames,
    };
  }

  // ==========================================
  // 分頁 5：班級設定
  // ==========================================
  function renderSettingsTab() {
    const state = store.getState();
    const st = state.settings;

    $("set-class-name").value = st.className;
    $("set-semester-name").value = st.semesterName;
    $("set-max-seat").value = st.maxSeat;
    $("set-test-seats").value = st.testSeats.join(", ");
    $("set-inactive-seats").value = st.inactiveSeats.join(", ");
    $("set-absent-mode").value = st.absentMode;
    $("set-helper-pin").value = st.helperPin || "";

    const lines = [];
    for (let s = 1; s <= st.maxSeat; s++) {
      const name = state.names[String(s)];
      if (name) lines.push(`${String(s).padStart(2, "0")} ${name}`);
    }
    $("set-roster-text").value = lines.join("\n");
  }

  // ==========================================
  // 彈窗（新增/編輯評量、備註、個人成績單）
  // ==========================================
  function openModal(html) {
    $("modal-box").innerHTML = html;
    $("modal-backdrop").classList.remove("hidden");
  }

  function closeModal() {
    $("modal-backdrop").classList.add("hidden");
    $("modal-box").innerHTML = "";
  }

  function openAddAssessmentModal(defaultCategory = "quiz") {
    const subj = getSubject(ui.activeSubjectId);
    const suggested = store.getNextDefaultTitle(ui.activeSubjectId, defaultCategory);
    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">新增「${escapeHtml(subj.name)}」${defaultCategory === "quiz" ? "小考" : "評量"}</h3>
        <button type="button" class="btn btn-secondary btn-xs" data-close-modal>✕</button>
      </div>
      <div class="form-grid-2">
        <div class="field-group">
          <label class="field-label" for="m-add-cat">成績類別</label>
          <select id="m-add-cat" class="input-select">
            ${CFG.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === defaultCategory ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field-group">
          <label class="field-label" for="m-add-max">滿分</label>
          <input id="m-add-max" type="number" min="1" max="1000" value="100" class="input-text" />
        </div>
        <div class="field-group" style="grid-column: 1 / -1;">
          <label class="field-label" for="m-add-title">評量名稱（預設為 ${escapeHtml(suggested)}）</label>
          <input id="m-add-title" type="text" class="input-text" placeholder="例如：L3 聽寫、第三單元小考（留白即用 ${escapeHtml(suggested)}）" />
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close-modal>取消</button>
        <button type="button" id="m-btn-create-assessment" class="btn btn-primary">建立並開始輸入</button>
      </div>
    `);

    const titleInput = $("m-add-title");
    titleInput.focus();

    const submit = () => {
      const cat = $("m-add-cat").value;
      const title = titleInput.value.trim();
      const maxScore = Number($("m-add-max").value) || 100;
      const item = store.addAssessment({
        subjectId: ui.activeSubjectId,
        category: cat,
        title,
        maxScore,
      });
      closeModal();
      if (ui.activeCategoryFilter !== "all" && ui.activeCategoryFilter !== cat) {
        ui.activeCategoryFilter = "all";
      }
      renderEntryTab();
      // 自動聚焦到新增欄位的 1 號，馬上就能打分數！
      const firstInput = $("grade-entry-table").querySelector(
        `input.score-input[data-seat="1"][data-assessment-id="${CSS.escape(item.id)}"]`,
      );
      if (firstInput) firstInput.focus();
      showToast(`已新增「${item.title}」`, "ok");
    };

    $("m-btn-create-assessment").addEventListener("click", submit);
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }

  function openEditAssessmentModal(assessmentId) {
    if (isHelperMode()) return;
    const item = store.getState().assessments.find((a) => a.id === assessmentId);
    if (!item) return;
    const subj = getSubject(item.subjectId);
    const lockedAttr = item.locked ? "disabled" : "";

    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">編輯「${escapeHtml(subj.name)} - ${escapeHtml(item.title)}」</h3>
        <button type="button" class="btn btn-secondary btn-xs" data-close-modal>✕</button>
      </div>
      ${
        item.locked
          ? `<div class="warn-banner" style="margin-top:0;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <span>🔒 此欄位目前已鎖定，無法修改、調分或刪除。</span>
              <button type="button" id="m-ed-unlock-now" class="btn btn-secondary btn-xs">🔓 立即解除鎖定</button>
            </div>`
          : ""
      }
      <div class="form-grid-2">
        <div class="field-group">
          <label class="field-label" for="m-ed-cat">成績類別</label>
          <select id="m-ed-cat" class="input-select" ${lockedAttr}>
            ${CFG.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === item.category ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field-group">
          <label class="field-label" for="m-ed-max">滿分</label>
          <input id="m-ed-max" type="number" min="1" max="1000" value="${item.maxScore}" class="input-text" ${lockedAttr} />
        </div>
        <div class="field-group" style="grid-column: 1 / -1;">
          <label class="field-label" for="m-ed-title">評量名稱</label>
          <input id="m-ed-title" type="text" class="input-text" value="${escapeHtml(item.title)}" ${lockedAttr} />
        </div>
      </div>

      <div class="config-box" style="margin-top: 14px;">
        <div class="field-label" style="margin-bottom: 8px;">整欄工具</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button type="button" class="btn btn-secondary btn-sm" id="m-ed-add5" ${lockedAttr}>全欄 +5 分</button>
          <button type="button" class="btn btn-secondary btn-sm" id="m-ed-sub5" ${lockedAttr}>全欄 -5 分</button>
          <button type="button" class="btn btn-secondary btn-sm" id="m-ed-clear-scores" ${lockedAttr}>清空此欄分數</button>
          <button type="button" class="btn btn-danger btn-sm" id="m-ed-delete" ${lockedAttr}>刪除此欄</button>
        </div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close-modal>關閉</button>
        ${item.locked ? "" : '<button type="button" id="m-btn-save-assessment" class="btn btn-primary">儲存修改</button>'}
      </div>
    `);

    if (item.locked && $("m-ed-unlock-now")) {
      $("m-ed-unlock-now").addEventListener("click", () => {
        store.setAssessmentLocked(assessmentId, false);
        renderEntryTable();
        openEditAssessmentModal(assessmentId);
        showToast(`已解除鎖定「${item.title}」`, "ok");
      });
    }

    if ($("m-btn-save-assessment")) {
      $("m-btn-save-assessment").addEventListener("click", () => {
        store.updateAssessment(assessmentId, {
          category: $("m-ed-cat").value,
          title: $("m-ed-title").value,
          maxScore: Number($("m-ed-max").value) || 100,
        });
        closeModal();
        renderEntryTab();
        showToast("已更新評量設定", "ok");
      });
    }

    $("m-ed-add5").addEventListener("click", () => {
      const cnt = store.bulkAdjustAssessment(assessmentId, "add", 5);
      closeModal();
      renderEntryTab();
      showToast(`已替 ${cnt} 位學生加 5 分`, "ok");
    });

    $("m-ed-sub5").addEventListener("click", () => {
      const cnt = store.bulkAdjustAssessment(assessmentId, "add", -5);
      closeModal();
      renderEntryTab();
      showToast(`已替 ${cnt} 位學生減 5 分`, "ok");
    });

    $("m-ed-clear-scores").addEventListener("click", () => {
      if (!confirm(`確定要清空「${item.title}」的所有分數嗎？`)) return;
      store.bulkAdjustAssessment(assessmentId, "clear");
      closeModal();
      renderEntryTab();
      showToast("已清空該欄分數");
    });

    $("m-ed-delete").addEventListener("click", () => {
      if (!confirm(`確定要刪除「${item.title}」整個欄位與分數嗎？`)) return;
      store.deleteAssessment(assessmentId);
      closeModal();
      renderEntryTab();
      showToast("已刪除評量欄位");
    });
  }

  function openEnterHelperModeModal() {
    const currentPin = store.getState().settings.helperPin ?? "4020";
    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">👩‍🎓 開啟學生協助登打模式</h3>
        <button type="button" class="btn btn-secondary btn-xs" data-close-modal>✕</button>
      </div>
      <p class="section-hint" style="margin-bottom: 12px;">
        開啟後畫面將自動隱藏學生姓名與其他分頁，<strong>僅開放「選擇科目、新增考試項目、輸入未鎖定欄位成績」</strong>。
        若希望已登打完的欄位不被誤改，建議先點該欄標題上的 🔓 鎖定後再開啟此模式。
      </p>
      <div class="field-group">
        <label class="field-label" for="m-helper-pin-setup">設定教師解除密碼（留白則不設密碼）</label>
        <input id="m-helper-pin-setup" type="text" class="input-text" value="${escapeHtml(currentPin)}" placeholder="預設 4020" />
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close-modal>取消</button>
        <button type="button" id="m-btn-confirm-enter-helper" class="btn btn-primary">🔒 開啟學生協助模式</button>
      </div>
    `);
    const pinInput = $("m-helper-pin-setup");
    pinInput.focus();
    pinInput.select();
    const confirmEnter = () => {
      store.setStudentHelperMode(true, pinInput.value);
      closeModal();
      switchTab("entry");
      showToast("已進入學生協助登打模式", "ok");
    };
    $("m-btn-confirm-enter-helper").addEventListener("click", confirmEnter);
    pinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmEnter();
      }
    });
  }

  function openExitHelperModeModal() {
    const requiredPin = store.getState().settings.helperPin || "";
    if (!requiredPin) {
      store.setStudentHelperMode(false, "");
      renderActiveTab();
      showToast("已解除學生協助模式", "ok");
      return;
    }
    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">🔓 教師解除學生協助模式</h3>
        <button type="button" class="btn btn-secondary btn-xs" data-close-modal>✕</button>
      </div>
      <div class="field-group">
        <label class="field-label" for="m-helper-pin-check">請輸入教師解除密碼</label>
        <input id="m-helper-pin-check" type="password" class="input-text" placeholder="輸入密碼" autocomplete="off" />
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close-modal>取消</button>
        <button type="button" id="m-btn-confirm-exit-helper" class="btn btn-primary">確認解除</button>
      </div>
    `);
    const checkInput = $("m-helper-pin-check");
    checkInput.focus();
    const confirmExit = () => {
      const res = store.setStudentHelperMode(false, checkInput.value);
      if (!res.ok) {
        showToast(res.error, "err");
        checkInput.select();
        return;
      }
      closeModal();
      renderActiveTab();
      showToast("已恢復教師完整功能", "ok");
    };
    $("m-btn-confirm-exit-helper").addEventListener("click", confirmExit);
    checkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmExit();
      }
    });
  }

  function openNoteModal(seat, assessmentId) {
    if (isHelperMode()) return;
    const item = store.getState().assessments.find((a) => a.id === assessmentId);
    if (!item || item.locked) return;
    const currentNote = item.notes[String(seat)] || "";
    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">${seat} 號 · ${escapeHtml(item.title)} 備註</h3>
        <button type="button" class="btn btn-secondary btn-xs" data-close-modal>✕</button>
      </div>
      <div class="field-group">
        <label class="field-label" for="m-note-input">備註內容（例如：11/25 補考完成、病假未考）</label>
        <input id="m-note-input" type="text" class="input-text" value="${escapeHtml(currentNote)}" placeholder="輸入備註，留空可清除" />
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close-modal>取消</button>
        <button type="button" id="m-btn-save-note" class="btn btn-primary">儲存備註</button>
      </div>
    `);
    const noteInput = $("m-note-input");
    noteInput.focus();
    const saveNote = () => {
      store.setNote(assessmentId, seat, noteInput.value);
      closeModal();
      renderEntryTable();
      showToast("已儲存備註", "ok");
    };
    $("m-btn-save-note").addEventListener("click", saveNote);
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveNote();
      }
    });
  }

  function openStudentDetailModal(seat) {
    const overview = store.computeAllSubjectsOverview();
    const row = overview.rows.find((r) => r.seat === seat);
    if (!row) return;
    const st = store.getState().settings;
    const displayName = st.hideNames ? "" : row.name;

    const subjectRowsHtml = CFG.SUBJECTS.map((subj) => {
      const sum = row.bySubject[subj.id];
      const assessments = store.getSubjectAssessments(subj.id);
      const quizDetails = assessments
        .filter((a) => a.category === "quiz")
        .map(
          (a) =>
            `${escapeHtml(a.title)}: <strong>${escapeHtml(csv.formatRawScoreForDisplay(a.scores[String(seat)]))}</strong>`,
        )
        .join("、");

      return `
        <tr>
          <td><strong>${escapeHtml(subj.name)}</strong></td>
          <td style="text-align:left;white-space:normal;font-size:0.8rem;">${quizDetails || "—"}</td>
          <td>${sum.quizAvg ?? "—"}</td>
          <td>${sum.midtermAvg ?? "—"}</td>
          <td>${sum.finalAvg ?? "—"}</td>
          <td style="font-weight:700;">${sum.subjectAvg ?? "—"}</td>
        </tr>
      `;
    }).join("");

    openModal(`
      <div class="modal-header">
        <div>
          <h3 class="modal-title">
            ${escapeHtml(st.className)} · 座號 ${seat} 號 ${displayName ? `(${escapeHtml(displayName)})` : ""}
            ${row.isTestSeat ? '<span class="badge badge-test">測試座號</span>' : ""}
          </h3>
          <div class="section-hint">${escapeHtml(st.semesterName)} · 總平均：${row.overallAvg ?? "—"} · ${row.isTestSeat ? "測試座號不列入班排" : `參考班排：${row.rank ?? "—"}`}</div>
        </div>
        <button type="button" class="btn btn-secondary btn-xs" data-close-modal>✕</button>
      </div>
      <div class="table-scroll">
        <table class="data-table compact-table">
          <thead>
            <tr>
              <th>科目</th>
              <th>小考明細</th>
              <th>小考平均</th>
              <th>期中考</th>
              <th>期末考</th>
              <th>科目平均</th>
            </tr>
          </thead>
          <tbody>${subjectRowsHtml}</tbody>
        </table>
      </div>
      <div class="modal-footer">
        <button type="button" id="m-btn-copy-slip" class="btn btn-soft">📋 複製文字成績單</button>
        <button type="button" id="m-btn-print-slip" class="btn btn-secondary">🖨️ 列印頁面</button>
        <button type="button" class="btn btn-primary" data-close-modal>關閉</button>
      </div>
    `);

    $("m-btn-copy-slip").addEventListener("click", async () => {
      const lines = [
        `【${st.className} ${st.semesterName} 成績單】`,
        `座號：${seat} 號${displayName ? ` ${displayName}` : ""}${row.isTestSeat ? "（測試座號）" : ""}`,
        ...CFG.SUBJECTS.map((subj) => {
          const s = row.bySubject[subj.id];
          return `${subj.name}：小考平均 ${s.quizAvg ?? "—"}｜期中 ${s.midtermAvg ?? "—"}｜期末 ${s.finalAvg ?? "—"}｜科目平均 ${s.subjectAvg ?? "—"}`;
        }),
        `六科總平均：${row.overallAvg ?? "—"}`,
      ];
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        showToast("已複製文字成績單到剪貼簿", "ok");
      } catch (_) {
        showToast("瀏覽器未授權剪貼簿，請手動選取複製", "err");
      }
    });

    $("m-btn-print-slip").addEventListener("click", () => window.print());
  }

  // ==========================================
  // 事件綁定
  // ==========================================
  function bindEvents() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("btn-enter-helper-mode").addEventListener("click", () => openEnterHelperModeModal());
    $("btn-exit-helper-mode").addEventListener("click", () => openExitHelperModeModal());

    $("btn-toggle-privacy").addEventListener("click", () => {
      if (isHelperMode()) return;
      const next = !store.getState().settings.hideNames;
      store.updateSettings({ hideNames: next });
      renderActiveTab();
    });

    $("btn-quick-import").addEventListener("click", () => switchTab("import"));
    $("btn-quick-export").addEventListener("click", () => switchTab("export"));

    $("btn-undo-snapshot").addEventListener("click", () => {
      if (store.restorePreImportSnapshot()) {
        ui.undoMessage = "";
        ui.importState = null;
        renderActiveTab();
        showToast("已復原到匯入前的成績狀態", "ok");
      }
    });

    $("subject-pills").addEventListener("click", (e) => {
      const btn = e.target.closest(".subject-pill");
      if (!btn) return;
      ui.activeSubjectId = btn.dataset.subjectId;
      renderEntryTab();
    });

    $("category-filter").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      ui.activeCategoryFilter = btn.dataset.cat;
      renderEntryTab();
    });

    $("chk-include-test-stats").addEventListener("change", (e) => {
      store.updateSettings({ includeTestInStats: e.target.checked });
      renderEntryTab();
    });

    $("btn-fill-test-seat").addEventListener("click", () => {
      store.fillTestSeatDemoScores();
      renderEntryTab();
      showToast("已替 29 號測試座號填入各科測試成績", "ok");
    });

    $("btn-add-quiz").addEventListener("click", () => openAddAssessmentModal("quiz"));
    $("btn-add-assessment").addEventListener("click", () => openAddAssessmentModal("midterm"));

    $("btn-export-current-subject").addEventListener("click", () => {
      const subj = getSubject(ui.activeSubjectId);
      const st = store.getState().settings;
      const csvText = csv.exportSubjectCsv(store, ui.activeSubjectId, {
        includeTestSeats: true,
        includeNames: !st.hideNames,
      });
      downloadTextFile(`${st.className}_${subj.name}_成績表.csv`, csvText);
      showToast(`已匯出「${subj.name}」CSV`, "ok");
    });

    const entryTable = $("grade-entry-table");
    entryTable.addEventListener("click", (e) => {
      const lockBtn = e.target.closest("[data-toggle-lock]");
      if (lockBtn) {
        if (isHelperMode()) return;
        const toggled = store.toggleAssessmentLock(lockBtn.dataset.toggleLock);
        if (toggled) {
          renderEntryTable();
          showToast(
            toggled.locked ? `已鎖定「${toggled.title}」，防止誤觸修改` : `已解除鎖定「${toggled.title}」`,
            toggled.locked ? "default" : "ok",
          );
        }
        return;
      }
      const editBtn = e.target.closest("[data-edit-assessment]");
      if (editBtn) {
        if (isHelperMode()) return;
        openEditAssessmentModal(editBtn.dataset.editAssessment);
        return;
      }
      const noteBtn = e.target.closest("[data-note-seat]");
      if (noteBtn) {
        if (isHelperMode()) return;
        openNoteModal(Number(noteBtn.dataset.noteSeat), noteBtn.dataset.noteAid);
      }
    });

    entryTable.addEventListener("focusin", (e) => {
      if (e.target.classList.contains("score-input")) {
        e.target.select();
      }
    });

    entryTable.addEventListener("change", (e) => {
      if (e.target.classList.contains("score-input")) {
        handleEntryCellCommit(e.target);
      }
    });

    entryTable.addEventListener("keydown", (e) => {
      if (!e.target.classList.contains("score-input")) return;
      if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        if (handleEntryCellCommit(e.target)) {
          moveEntryFocus(e.target, 1, 0);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (handleEntryCellCommit(e.target)) {
          moveEntryFocus(e.target, -1, 0);
        }
      } else if (e.key === "ArrowRight" && e.target.selectionStart === e.target.value.length) {
        e.preventDefault();
        if (handleEntryCellCommit(e.target)) {
          moveEntryFocus(e.target, 0, 1);
        }
      } else if (e.key === "ArrowLeft" && e.target.selectionStart === 0) {
        e.preventDefault();
        if (handleEntryCellCommit(e.target)) {
          moveEntryFocus(e.target, 0, -1);
        }
      }
    });

    $("overview-metric-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      ui.overviewMetric = btn.dataset.metric;
      renderOverviewTab();
    });

    $("chk-overview-only-alert").addEventListener("change", (e) => {
      ui.overviewOnlyAlert = e.target.checked;
      renderOverviewTab();
    });

    $("btn-print-overview").addEventListener("click", () => window.print());
    $("btn-export-overview-now").addEventListener("click", () => {
      const st = store.getState().settings;
      const csvText = csv.exportOverviewCsv(store, {
        includeTestSeats: true,
        includeNames: !st.hideNames,
        metric: "all_details",
      });
      downloadTextFile(`${st.className}_全科成績總表.csv`, csvText);
      showToast("已匯出全科成績總表 CSV", "ok");
    });

    $("overview-table").addEventListener("click", (e) => {
      const row = e.target.closest("tr[data-student-detail]");
      if (row) openStudentDetailModal(Number(row.dataset.studentDetail));
    });

    const dropzone = $("csv-dropzone");
    const fileInput = $("csv-file-input");

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) handleUploadedCsvFile(file);
    });

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) handleUploadedCsvFile(file);
      fileInput.value = "";
    });

    $("csv-paste-input").addEventListener("input", (e) => {
      startImportFromText(e.target.value, { encoding: "文字貼上" });
    });

    $("btn-sample-two-col").addEventListener("click", () => {
      const sample = ["座號,分數", "1,94", "2,88", "3,76", "4,91", "5,65", "29,98"].join("\n");
      $("csv-paste-input").value = sample;
      startImportFromText(sample, { encoding: "示範資料" });
    });

    $("btn-sample-wide").addEventListener("click", () => {
      const sample = [
        "座號,姓名,國語-第1次小考,國語-期中考,數學-第1次小考,數學-期末考",
        "1,王小明,92,89,95,91",
        "2,陳小華,85,82,78,84",
        "29,測試座號,90,93,88,95",
      ].join("\n");
      $("csv-paste-input").value = sample;
      startImportFromText(sample, { encoding: "示範資料" });
    });

    $("btn-clear-import").addEventListener("click", () => {
      $("csv-paste-input").value = "";
      ui.importState = null;
      renderImportTab();
    });

    $("btn-tpl-quick").addEventListener("click", () => {
      const st = store.getState().settings;
      downloadTextFile(
        `${st.className}_極速兩欄範本.csv`,
        csv.generateTemplateCsv("quick_two_col", store, ui.activeSubjectId),
      );
    });
    $("btn-tpl-wide").addEventListener("click", () => {
      const st = store.getState().settings;
      const subj = getSubject(ui.activeSubjectId);
      downloadTextFile(
        `${st.className}_${subj.name}_寬表範本.csv`,
        csv.generateTemplateCsv("subject_wide", store, ui.activeSubjectId),
      );
    });
    $("btn-tpl-long").addEventListener("click", () => {
      const st = store.getState().settings;
      downloadTextFile(
        `${st.className}_全科明細範本.csv`,
        csv.generateTemplateCsv("long_all", store, ui.activeSubjectId),
      );
    });

    $("imp-target-subject").addEventListener("change", (e) => {
      if (!ui.importState) return;
      ui.importState.config.targetSubjectId = e.target.value;
      const list = store.getSubjectAssessments(e.target.value, ui.importState.config.targetCategory);
      ui.importState.config.targetAssessmentId = list[0] ? list[0].id : "__NEW__";
      renderImportTab();
    });

    $("imp-target-category").addEventListener("change", (e) => {
      if (!ui.importState) return;
      ui.importState.config.targetCategory = e.target.value;
      const list = store.getSubjectAssessments(ui.importState.config.targetSubjectId, e.target.value);
      ui.importState.config.targetAssessmentId = list[0] ? list[0].id : "__NEW__";
      renderImportTab();
    });

    $("imp-target-assessment").addEventListener("change", (e) => {
      if (!ui.importState) return;
      ui.importState.config.targetAssessmentId = e.target.value;
      renderImportTab();
    });

    $("imp-new-title").addEventListener("input", (e) => {
      if (!ui.importState) return;
      ui.importState.config.targetTitle = e.target.value;
      renderImportTab();
    });

    $("btn-apply-wide-default-subj").addEventListener("click", () => {
      if (!ui.importState) return;
      const subjId = $("imp-wide-default-subject").value;
      ui.importState.config.wideDefaultSubjectId = subjId;
      for (const m of ui.importState.config.columnMappings) {
        if (m.role === "score" && m.action === "import") {
          const detected = csv.parseHeaderDescriptor(m.header, "__NONE__");
          if (detected.subjectId === "__NONE__") m.subjectId = subjId;
        }
      }
      renderImportTab();
    });

    $("imp-wide-mapping-table").addEventListener("change", (e) => {
      if (!ui.importState) return;
      const idx = e.target.dataset.wideMapIdx;
      const field = e.target.dataset.wideField;
      if (idx === undefined || !field) return;
      ui.importState.config.columnMappings[Number(idx)][field] = e.target.value;
      renderImportTab();
    });

    $("chk-imp-overwrite").addEventListener("change", (e) => {
      if (!ui.importState) return;
      ui.importState.config.overwriteExisting = e.target.checked;
      renderImportTab();
    });

    $("chk-imp-include-test").addEventListener("change", (e) => {
      if (!ui.importState) return;
      ui.importState.config.includeTestSeats = e.target.checked;
      renderImportTab();
    });

    $("btn-commit-import").addEventListener("click", () => {
      if (!ui.importState || !ui.importState.lastPreview) return;
      const preview = ui.importState.lastPreview;
      if (preview.operations.length === 0) return;

      const res = store.applyImportOperations(preview.operations, {
        overwriteExisting: ui.importState.config.overwriteExisting,
        includeTestSeats: ui.importState.config.includeTestSeats,
      });

      if (preview.stats.affectedSubjects.length === 1) {
        ui.activeSubjectId = preview.stats.affectedSubjects[0];
      }
      ui.undoMessage = `剛完成 CSV 匯入：新增 ${res.addedCount} 筆、更新 ${res.updatedCount} 筆（若需退回可按右側復原）`;
      ui.importState = null;
      $("csv-paste-input").value = "";
      switchTab("entry");
      showToast(`匯入完成！新增 ${res.addedCount} 筆、更新 ${res.updatedCount} 筆`, "ok");
    });

    $("btn-do-export-subject").addEventListener("click", () => {
      const subjId = $("exp-subject-select").value;
      const subj = getSubject(subjId);
      const st = store.getState().settings;
      const text = csv.exportSubjectCsv(store, subjId, getExportOptionsFromUi());
      downloadTextFile(`${st.className}_${subj.name}_成績明細.csv`, text);
      showToast(`已下載「${subj.name}」CSV`, "ok");
    });

    $("btn-do-export-overview").addEventListener("click", () => {
      const metric = $("exp-overview-metric").value;
      const st = store.getState().settings;
      const text = csv.exportOverviewCsv(store, { ...getExportOptionsFromUi(), metric });
      downloadTextFile(`${st.className}_六科成績總表.csv`, text);
      showToast("已下載全科總表 CSV", "ok");
    });

    $("btn-do-export-long").addEventListener("click", () => {
      const st = store.getState().settings;
      const text = csv.exportLongCsv(store, getExportOptionsFromUi());
      downloadTextFile(`${st.className}_完整成績備份明細.csv`, text);
      showToast("已下載完整明細 CSV", "ok");
    });

    $("btn-save-basic-settings").addEventListener("click", () => {
      const parseSeatList = (str) =>
        String(str || "")
          .split(/[,，\s]+/)
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 50);

      store.updateSettings({
        className: $("set-class-name").value,
        semesterName: $("set-semester-name").value,
        maxSeat: Math.max(1, Math.min(50, Number($("set-max-seat").value) || 29)),
        testSeats: parseSeatList($("set-test-seats").value),
        inactiveSeats: parseSeatList($("set-inactive-seats").value),
        absentMode: $("set-absent-mode").value,
        helperPin: $("set-helper-pin").value.trim(),
      });
      renderActiveTab();
      showToast("已儲存班級與座號設定", "ok");
    });

    $("btn-save-roster").addEventListener("click", () => {
      const map = store.parseRosterText($("set-roster-text").value);
      store.setNamesMap(map, true);
      renderActiveTab();
      showToast(`已儲存 ${Object.keys(map).length} 位學生本機姓名`, "ok");
    });

    $("btn-clear-roster").addEventListener("click", () => {
      if (!confirm("確定要清空所有本機姓名對照嗎？（不會影響座號與分數）")) return;
      store.setNamesMap({}, true);
      renderSettingsTab();
      showToast("已清空姓名對照表");
    });

    $("btn-tool-fill-29").addEventListener("click", () => {
      store.fillTestSeatDemoScores();
      renderActiveTab();
      showToast("已替 29 號測試座號填入各科測試成績", "ok");
    });

    $("btn-tool-clear-29").addEventListener("click", () => {
      store.clearTestSeatScores();
      renderActiveTab();
      showToast("已清除 29 號測試座號成績");
    });

    $("btn-tool-load-demo").addEventListener("click", () => {
      if (!confirm("將載入 1~29 號示範班級成績（會自動備份現有資料，可隨時復原），是否繼續？")) return;
      store.loadClassDemoData();
      ui.undoMessage = "已載入全班示範資料（若要回復載入前狀態，可按右側復原）";
      switchTab("overview");
      showToast("已載入 1~29 號示範成績資料", "ok");
    });

    $("btn-tool-export-json").addEventListener("click", () => {
      const st = store.getState().settings;
      downloadTextFile(
        `${st.className}_成績系統完整備份.json`,
        store.exportBackupJson(),
        "application/json;charset=utf-8",
      );
      showToast("已匯出 JSON 完整備份", "ok");
    });

    $("btn-tool-import-json").addEventListener("click", () => $("json-backup-input").click());
    $("json-backup-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        store.importBackupJson(text);
        ui.undoMessage = "剛從 JSON 備份還原資料（可復原為還原前狀態）";
        renderActiveTab();
        showToast("JSON 備份還原成功", "ok");
      } catch (err) {
        showToast(`還原失敗：${err.message}`, "err");
      }
      e.target.value = "";
    });

    $("btn-tool-reset-all").addEventListener("click", () => {
      if (!confirm("確定要清空全部學生成績與評量嗎？（系統仍會保留一次復原快照）")) return;
      store.resetAllData();
      ui.undoMessage = "剛清空全部資料（如誤按可立即點擊右側復原）";
      renderActiveTab();
      showToast("已重置為空白成績冊");
    });

    $("modal-backdrop").addEventListener("click", (e) => {
      if (e.target === $("modal-backdrop") || e.target.closest("[data-close-modal]")) {
        closeModal();
      }
    });
  }

  async function handleUploadedCsvFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const { text, encoding } = csv.decodeFileBuffer(buf);
      $("csv-paste-input").value = text;
      startImportFromText(text, { encoding });
      showToast(`已載入檔案「${file.name}」（${encoding}）`, "ok");
    } catch (err) {
      showToast(`讀取檔案失敗：${err.message}`, "err");
    }
  }

  bindEvents();
  renderActiveTab();
})();
