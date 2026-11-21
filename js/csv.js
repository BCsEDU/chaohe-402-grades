// CSV / TSV 雙向解析與匯出引擎（支援 UTF-8 BOM、Big5 自動偵測與多格式智慧對應）
(function (global) {
  const CFG = global.GRADE_CONFIG;

  function escapeCsvCell(val) {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (/[",\r\n\t]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function toCsvString(rows) {
    const lines = rows.map((row) => row.map(escapeCsvCell).join(","));
    return "\uFEFF" + lines.join("\r\n");
  }

  function decodeFileBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let slice = bytes;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      slice = bytes.subarray(3);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
      return { text, encoding: "UTF-8" };
    } catch (_) {
      try {
        const text = new TextDecoder("big5").decode(bytes);
        return { text, encoding: "Big5" };
      } catch (__) {
        const text = new TextDecoder("utf-8").decode(slice);
        return { text, encoding: "UTF-8 (寬鬆)" };
      }
    }
  }

  function detectDelimiter(text) {
    const sampleLines = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 8);

    if (sampleLines.length === 0) return ",";

    let commas = 0;
    let tabs = 0;
    let semis = 0;
    for (const line of sampleLines) {
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (!inQuotes) {
          if (ch === ",") commas++;
          else if (ch === "\t") tabs++;
          else if (ch === ";") semis++;
        }
      }
    }

    if (tabs > 0 && tabs >= commas && tabs >= semis) return "\t";
    if (commas > 0 && commas >= semis) return ",";
    if (semis > 0) return ";";

    // 若完全沒有分隔符號，檢查是否為空白分隔的 "座號 分數" 貼上文字
    const spacePatternCount = sampleLines.filter((l) => /^\s*0*\d{1,2}\s*號?\s+[^\s]+/.test(l)).length;
    if (spacePatternCount >= Math.max(1, Math.floor(sampleLines.length / 2))) {
      return "SPACE";
    }
    return ",";
  }

  function parseDelimitedText(rawText) {
    const text = String(rawText || "").replace(/^\uFEFF/, "");
    if (!text.trim()) return { rows: [], delimiter: "," };

    const delimiter = detectDelimiter(text);
    if (delimiter === "SPACE") {
      const rows = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/));
      return { rows, delimiter: "空白" };
    }

    const rows = [];
    let currentRow = [];
    let currentCell = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          currentCell += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          currentCell += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          currentRow.push(currentCell.trim());
          currentCell = "";
        } else if (ch === "\r" && next === "\n") {
          currentRow.push(currentCell.trim());
          rows.push(currentRow);
          currentRow = [];
          currentCell = "";
          i++;
        } else if (ch === "\n" || ch === "\r") {
          currentRow.push(currentCell.trim());
          rows.push(currentRow);
          currentRow = [];
          currentCell = "";
        } else {
          currentCell += ch;
        }
      }
    }

    if (currentCell.length > 0 || currentRow.length > 0) {
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
    }

    const nonEmptyRows = rows.filter((r) => r.some((cell) => cell !== ""));
    return {
      rows: nonEmptyRows,
      delimiter: delimiter === "\t" ? "Tab" : delimiter,
    };
  }

  function parseSeatToken(token, maxSeat = 29) {
    const s = String(token || "").trim();
    if (!s) return null;
    const cleaned = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const m = cleaned.match(/^0*(\d{1,2})\s*號?$/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > maxSeat) return { outOfRange: n };
    return { seat: n };
  }

  function matchSubject(token) {
    const s = String(token || "").trim().toLowerCase();
    if (!s) return null;
    for (const subj of CFG.SUBJECTS) {
      if (subj.id.toLowerCase() === s || subj.name.toLowerCase() === s || subj.short.toLowerCase() === s) {
        return subj.id;
      }
      if (subj.aliases.some((al) => al.toLowerCase() === s)) {
        return subj.id;
      }
    }
    return null;
  }

  function matchCategory(token) {
    const s = String(token || "").trim().toLowerCase();
    if (!s) return null;
    for (const cat of CFG.CATEGORIES) {
      if (cat.id.toLowerCase() === s || cat.name.toLowerCase() === s || cat.short.toLowerCase() === s) {
        return cat.id;
      }
      if (cat.aliases.some((al) => al.toLowerCase() === s)) {
        return cat.id;
      }
    }
    return null;
  }

  function inferCategoryFromTitle(title) {
    const s = String(title || "").trim().toLowerCase();
    if (/期中|一次段考|第一次定期|段考一|midterm/.test(s)) return "midterm";
    if (/期末|二次段考|第二次定期|段考二|final/.test(s)) return "final";
    return "quiz";
  }

  function parseHeaderDescriptor(header, defaultSubjectId) {
    const raw = String(header || "").trim();
    if (!raw) {
      return { subjectId: defaultSubjectId, category: "quiz", title: "未命名評量", ignore: false };
    }

    const ignoredExact = new Set([
      "座號",
      "號碼",
      "編號",
      "seat",
      "no",
      "id",
      "姓名",
      "學生姓名",
      "name",
      "身份標記",
      "身分標記",
      "測試標記",
      "標記",
      "備註欄",
      "小考平均",
      "期中平均",
      "期末平均",
      "期中考平均",
      "期末考平均",
      "學期加權總分",
      "加權總分",
      "科目平均",
      "總平均",
      "等第",
      "排名",
      "班級參考排名",
      "未及格科數",
      "缺考次數",
    ]);

    if (ignoredExact.has(raw.toLowerCase()) || /-(小考平均|加權總分|科目平均|總平均)$/.test(raw)) {
      return { subjectId: defaultSubjectId, category: "quiz", title: raw, ignore: true };
    }

    // 檢查 "科目-評量名稱" 或 "科目_評量名稱" 或 "科目 評量名稱"
    let detectedSubject = null;
    let restTitle = raw;

    const sepMatch = raw.match(/^([^\-_：\s]+)\s*[-_：\s]+\s*(.+)$/);
    if (sepMatch) {
      const maybeSubj = matchSubject(sepMatch[1]);
      if (maybeSubj) {
        detectedSubject = maybeSubj;
        restTitle = sepMatch[2].trim();
      }
    }

    // 若無分隔符，檢查是否直接以完整科目名稱開頭，如 "國語期中考"
    if (!detectedSubject) {
      for (const subj of CFG.SUBJECTS) {
        if (raw.startsWith(subj.name) && raw.length > subj.name.length) {
          detectedSubject = subj.id;
          restTitle = raw.slice(subj.name.length).replace(/^[\-_：\s]+/, "").trim();
          break;
        }
      }
    }

    const finalSubject = detectedSubject || defaultSubjectId;
    const exactCat = matchCategory(restTitle);
    const category = exactCat || inferCategoryFromTitle(restTitle);

    return {
      subjectId: finalSubject,
      category,
      title: restTitle || raw,
      ignore: false,
    };
  }

  function findHeaderIndex(headers, candidates) {
    const normalized = headers.map((h) => String(h || "").trim().toLowerCase());
    for (const cand of candidates) {
      const idx = normalized.indexOf(cand.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function analyzeCsvRows(rows, store, options = {}) {
    const defaultSubjectId = options.defaultSubjectId || CFG.SUBJECTS[0].id;
    const maxSeat = store.getState().settings.maxSeat;

    if (!rows || rows.length === 0) {
      return { error: "沒有可解析的資料列" };
    }

    const seatCandidates = ["座號", "號碼", "編號", "seat", "no", "student_no"];
    let firstRow = rows[0].map((c) => String(c || "").trim());
    let dataStartIdx = 1;

    // 支援 Apple Numbers / Excel 雙列標題合併（例如第1列是評量名稱、第2列是「座號 / 姓名」）
    if (
      rows.length >= 2 &&
      findHeaderIndex(firstRow, seatCandidates) === -1 &&
      findHeaderIndex(rows[1], seatCandidates) !== -1
    ) {
      const colCount = Math.max(rows[0].length, rows[1].length);
      const merged = [];
      for (let i = 0; i < colCount; i++) {
        const top = String(rows[0][i] || "").trim();
        const sub = String(rows[1][i] || "").trim();
        merged.push(top || sub);
      }
      firstRow = merged;
      dataStartIdx = 2;
    }

    const bodyRows = rows.slice(dataStartIdx);
    const seatIdx = findHeaderIndex(firstRow, seatCandidates);
    const nameIdx = findHeaderIndex(firstRow, ["姓名", "學生姓名", "name"]);
    const subjIdx = findHeaderIndex(firstRow, ["科目", "學科", "subject"]);
    const catIdx = findHeaderIndex(firstRow, ["成績類別", "類別", "評量類別", "category"]);
    const titleIdx = findHeaderIndex(firstRow, ["評量名稱", "評量項目", "名稱", "項目", "exam", "title"]);
    const dateIdx = findHeaderIndex(firstRow, ["日期", "測驗日期", "date"]);
    const maxIdx = findHeaderIndex(firstRow, ["滿分", "max", "max_score"]);
    const scoreIdx = findHeaderIndex(firstRow, ["分數", "成績", "得分", "總分", "score", "grade", "points"]);
    const noteIdx = findHeaderIndex(firstRow, ["備註", "note", "notes"]);

    // 1. 明細長表格式（需有 座號 + 科目 + 分數）
    if (seatIdx !== -1 && subjIdx !== -1 && scoreIdx !== -1) {
      return {
        mode: "long",
        modeLabel: "多科明細格式（自動對應科目、類別與評量）",
        hasHeader: true,
        headers: firstRow,
        dataRows: bodyRows,
        colIndexes: { seatIdx, nameIdx, subjIdx, catIdx, titleIdx, dateIdx, maxIdx, scoreIdx, noteIdx },
      };
    }

    // 2. 無標題列的極速格式：首欄即為座號（1~29）
    const firstIsSeat = parseSeatToken(firstRow[0], maxSeat);
    if (seatIdx === -1 && nameIdx === -1 && firstIsSeat && firstIsSeat.seat && firstRow.length >= 2) {
      const looksLikeScore =
        firstRow.length === 2
          ? true
          : store.parseCellInput(firstRow[firstRow.length - 1], 1000).valid;
      if (looksLikeScore) {
        const valueColIdx = firstRow.length >= 3 ? firstRow.length - 1 : 1;
        return {
          mode: "two_col",
          modeLabel: "極速座號＋分數（無標題列）",
          hasHeader: false,
          headers: firstRow.length >= 3 ? ["座號", "姓名", "分數"] : ["座號", "分數"],
          dataRows: rows,
          seatColIdx: 0,
          nameColIdx: firstRow.length >= 3 ? 1 : -1,
          scoreColIdx: valueColIdx,
          suggestedTitle: "",
        };
      }
    }

    // 3. 有標題列且含「座號」或「姓名」
    if (seatIdx !== -1 || nameIdx !== -1) {
      const metaIndexes = new Set(
        [seatIdx, nameIdx, noteIdx].filter((i) => i !== -1),
      );

      // 若明確只有一個分數欄（例如 Google 表單、學力測驗匯出：座號 + 姓名 + 分數），進入極速兩欄模式
      const scoreCols = [];
      firstRow.forEach((h, idx) => {
        if (metaIndexes.has(idx) || !h) return;
        const desc = parseHeaderDescriptor(h, defaultSubjectId);
        if (!desc.ignore) {
          scoreCols.push({ colIndex: idx, header: h, ...desc });
        }
      });

      if (scoreCols.length === 1 && (scoreIdx !== -1 || firstRow.length <= 3)) {
        const sc = scoreCols[0];
        return {
          mode: "two_col",
          modeLabel: "單次成績快速登錄",
          hasHeader: true,
          headers: firstRow,
          dataRows: bodyRows,
          seatColIdx: seatIdx,
          nameColIdx: nameIdx,
          scoreColIdx: sc.colIndex,
          suggestedSubjectId: sc.subjectId,
          suggestedCategory: sc.category,
          suggestedTitle: sc.header === "分數" || sc.header === "成績" ? "" : sc.title,
        };
      }

      // 寬表多欄格式（包含系統匯出的單科表 / 全科總表 / Numbers 匯出表）
      const columnMappings = firstRow.map((h, idx) => {
        if (idx === seatIdx) {
          return { colIndex: idx, header: h, role: "seat", action: "ignore" };
        }
        if (idx === nameIdx) {
          return { colIndex: idx, header: h, role: "name", action: "ignore" };
        }
        if (!String(h || "").trim()) {
          return { colIndex: idx, header: "(空白欄)", role: "score", action: "ignore", subjectId: defaultSubjectId, category: "quiz", title: "" };
        }
        const desc = parseHeaderDescriptor(h, defaultSubjectId);
        return {
          colIndex: idx,
          header: h,
          role: "score",
          action: desc.ignore ? "ignore" : "import",
          subjectId: desc.subjectId,
          category: desc.category,
          title: desc.title,
        };
      });

      // 自動區分同科同類別的重複欄名（例如兩個 "L2" 自動編為 "L2 (1)"、"L2 (2)"）
      const dupCounts = new Map();
      for (const m of columnMappings) {
        if (m.role !== "score" || m.action !== "import") continue;
        const key = `${m.subjectId}|${m.category}|${m.title}`;
        dupCounts.set(key, (dupCounts.get(key) || 0) + 1);
      }
      const seenCounts = new Map();
      for (const m of columnMappings) {
        if (m.role !== "score" || m.action !== "import") continue;
        const key = `${m.subjectId}|${m.category}|${m.title}`;
        if (dupCounts.get(key) > 1) {
          const idxNum = (seenCounts.get(key) || 0) + 1;
          seenCounts.set(key, idxNum);
          m.title = `${m.title} (${idxNum})`;
        }
      }

      return {
        mode: "wide",
        modeLabel: "多欄寬表格式（已自動忽略姓名以保護隱私）",
        hasHeader: true,
        headers: firstRow,
        dataRows: bodyRows,
        seatColIdx: seatIdx,
        nameColIdx: nameIdx,
        columnMappings,
      };
    }

    return {
      error: "無法辨識座號或成績欄位。請確認第一列有「座號」標題，或直接以「座號, 分數」格式貼上。",
    };
  }

  function formatRawScoreForDisplay(val) {
    if (val === undefined || val === null) return "空白";
    if (val === "ABSENT") return "缺考";
    if (val === "EXEMPT") return "免考";
    return String(val);
  }

  function buildImportPreview(analysis, store, config = {}) {
    const state = store.getState();
    const maxSeat = state.settings.maxSeat;
    const includeTestSeats = config.includeTestSeats !== false;
    const overwriteExisting = config.overwriteExisting !== false;

    const operations = [];
    const warnings = [];

    function resolveSeat(seatCell, nameCell, rowNum) {
      if (seatCell !== undefined && seatCell !== "") {
        const parsedSeat = parseSeatToken(seatCell, maxSeat);
        if (parsedSeat && parsedSeat.seat) return parsedSeat.seat;
        if (parsedSeat && parsedSeat.outOfRange) {
          warnings.push({ rowNum, message: `座號 ${parsedSeat.outOfRange} 超出 1~${maxSeat} 範圍，已略過` });
          return null;
        }
      }
      if (nameCell) {
        const found = store.findSeatByName(nameCell);
        if (found) return found;
      }
      warnings.push({ rowNum, message: `無法辨識座號（${seatCell || nameCell || "空白"}），已略過` });
      return null;
    }

    function findExistingAssessment(subjectId, category, title, preferredId) {
      if (preferredId) {
        const hit = state.assessments.find((a) => a.id === preferredId);
        if (hit) return hit;
      }
      return state.assessments.find(
        (a) => a.subjectId === subjectId && a.category === category && a.title === String(title || "").trim(),
      );
    }

    if (analysis.mode === "long") {
      const { seatIdx, nameIdx, subjIdx, catIdx, titleIdx, dateIdx, maxIdx, scoreIdx, noteIdx } = analysis.colIndexes;
      analysis.dataRows.forEach((row, i) => {
        const rowNum = i + 2;
        const seat = resolveSeat(row[seatIdx], nameIdx !== -1 ? row[nameIdx] : "", rowNum);
        if (!seat) return;
        if (!includeTestSeats && store.isTestSeat(seat)) return;

        const subjId = matchSubject(row[subjIdx]);
        if (!subjId) {
          warnings.push({ rowNum, message: `無法辨識科目「${row[subjIdx] || ""}」，已略過` });
          return;
        }

        const rawTitle = titleIdx !== -1 ? String(row[titleIdx] || "").trim() : "";
        const rawCat = catIdx !== -1 ? matchCategory(row[catIdx]) : null;
        const category = rawCat || inferCategoryFromTitle(rawTitle);
        const title =
          rawTitle ||
          CFG.CATEGORIES.find((c) => c.id === category)?.name ||
          "第1次小考";

        const maxScore = maxIdx !== -1 && Number(row[maxIdx]) > 0 ? Number(row[maxIdx]) : 100;
        const rawVal = row[scoreIdx];
        const parsedScore = store.parseCellInput(rawVal, maxScore);

        if (!parsedScore.valid) {
          warnings.push({ rowNum, message: `座號 ${seat}（${title}）：${parsedScore.error}（內容：「${rawVal}」）` });
          return;
        }
        if (parsedScore.value === null) return;

        const existing = findExistingAssessment(subjId, category, title);
        if (existing && existing.locked) {
          warnings.push({ rowNum, message: `座號 ${seat}（${title}）：該欄位已鎖定，已略過覆蓋` });
          return;
        }
        const oldValue = existing ? existing.scores[String(seat)] : undefined;
        if (oldValue !== undefined && !overwriteExisting) return;

        operations.push({
          rowNum,
          seat,
          isTestSeat: store.isTestSeat(seat),
          subjectId: subjId,
          category,
          assessmentId: existing ? existing.id : null,
          title,
          date: dateIdx !== -1 ? String(row[dateIdx] || "").trim() : "",
          maxScore,
          value: parsedScore.value,
          note: noteIdx !== -1 ? String(row[noteIdx] || "").trim() : "",
          oldValue,
          changeType: oldValue === undefined ? "add" : oldValue === parsedScore.value ? "unchanged" : "update",
        });
      });
    } else if (analysis.mode === "two_col") {
      const targetSubjectId = config.targetSubjectId || analysis.suggestedSubjectId || CFG.SUBJECTS[0].id;
      const targetCategory = config.targetCategory || analysis.suggestedCategory || "quiz";
      const targetAssessmentId = config.targetAssessmentId || null;
      const existing = findExistingAssessment(
        targetSubjectId,
        targetCategory,
        config.targetTitle || analysis.suggestedTitle,
        targetAssessmentId,
      );
      const targetTitle =
        (existing && existing.title) ||
        (config.targetTitle && config.targetTitle.trim()) ||
        analysis.suggestedTitle ||
        (store.getNextDefaultTitle
          ? store.getNextDefaultTitle(targetSubjectId, targetCategory)
          : CFG.CATEGORIES.find((c) => c.id === targetCategory)?.name || "小考");
      const maxScore = existing ? existing.maxScore : 100;

      const startRowNum = analysis.hasHeader ? 2 : 1;
      analysis.dataRows.forEach((row, i) => {
        const rowNum = i + startRowNum;
        const seatCell = analysis.seatColIdx !== -1 ? row[analysis.seatColIdx] : "";
        const nameCell = analysis.nameColIdx !== -1 ? row[analysis.nameColIdx] : "";
        const seat = resolveSeat(seatCell, nameCell, rowNum);
        if (!seat) return;
        if (!includeTestSeats && store.isTestSeat(seat)) return;

        const rawVal = row[analysis.scoreColIdx];
        const parsedScore = store.parseCellInput(rawVal, maxScore);
        if (!parsedScore.valid) {
          warnings.push({ rowNum, message: `座號 ${seat}：${parsedScore.error}（內容：「${rawVal}」）` });
          return;
        }
        if (parsedScore.value === null) return;

        if (existing && existing.locked) {
          warnings.push({ rowNum, message: `座號 ${seat}（${targetTitle}）：該欄位已鎖定，已略過覆蓋` });
          return;
        }
        const oldValue = existing ? existing.scores[String(seat)] : undefined;
        if (oldValue !== undefined && !overwriteExisting) return;

        operations.push({
          rowNum,
          seat,
          isTestSeat: store.isTestSeat(seat),
          subjectId: targetSubjectId,
          category: targetCategory,
          assessmentId: existing ? existing.id : null,
          title: targetTitle,
          date: "",
          maxScore,
          value: parsedScore.value,
          note: "",
          oldValue,
          changeType: oldValue === undefined ? "add" : oldValue === parsedScore.value ? "unchanged" : "update",
        });
      });
    } else if (analysis.mode === "wide") {
      const mappings = config.columnMappings || analysis.columnMappings || [];
      const activeCols = mappings.filter((m) => m.role === "score" && m.action === "import");

      analysis.dataRows.forEach((row, i) => {
        const rowNum = i + 2;
        const seatCell = analysis.seatColIdx !== -1 ? row[analysis.seatColIdx] : "";
        const nameCell = analysis.nameColIdx !== -1 ? row[analysis.nameColIdx] : "";
        // 跳過匯出csv底部的統計列
        if (/^(班級平均|最高分|最低分|及格人數|及格率)/.test(String(seatCell || "").trim())) return;

        const seat = resolveSeat(seatCell, nameCell, rowNum);
        if (!seat) return;
        if (!includeTestSeats && store.isTestSeat(seat)) return;

        for (const col of activeCols) {
          const rawVal = row[col.colIndex];
          const existing = findExistingAssessment(col.subjectId, col.category, col.title);
          if (existing && existing.locked) {
            warnings.push({ rowNum, message: `座號 ${seat}（${col.title}）：該欄位已鎖定，已略過覆蓋` });
            continue;
          }
          const maxScore = existing ? existing.maxScore : 100;
          const parsedScore = store.parseCellInput(rawVal, maxScore);
          if (!parsedScore.valid) {
            warnings.push({
              rowNum,
              message: `座號 ${seat}（${col.title}）：${parsedScore.error}（內容：「${rawVal}」）`,
            });
            continue;
          }
          if (parsedScore.value === null) continue;

          const oldValue = existing ? existing.scores[String(seat)] : undefined;
          if (oldValue !== undefined && !overwriteExisting) continue;

          operations.push({
            rowNum,
            seat,
            isTestSeat: store.isTestSeat(seat),
            subjectId: col.subjectId,
            category: col.category,
            assessmentId: existing ? existing.id : null,
            title: col.title,
            date: "",
            maxScore,
            value: parsedScore.value,
            note: "",
            oldValue,
            changeType: oldValue === undefined ? "add" : oldValue === parsedScore.value ? "unchanged" : "update",
          });
        }
      });
    }

    const addCount = operations.filter((o) => o.changeType === "add").length;
    const updateCount = operations.filter((o) => o.changeType === "update").length;
    const unchangedCount = operations.filter((o) => o.changeType === "unchanged").length;
    const testSeatCount = operations.filter((o) => o.isTestSeat).length;
    const affectedSubjects = Array.from(new Set(operations.map((o) => o.subjectId)));

    return {
      operations,
      warnings,
      stats: {
        totalOps: operations.length,
        addCount,
        updateCount,
        unchangedCount,
        testSeatCount,
        warningCount: warnings.length,
        affectedSubjects,
      },
    };
  }

  function formatCellForCsvExport(rawVal) {
    if (rawVal === undefined || rawVal === null) return "";
    if (rawVal === "ABSENT") return "缺考";
    if (rawVal === "EXEMPT") return "免考";
    return rawVal;
  }

  function exportSubjectCsv(store, subjectId, options = {}) {
    const { includeTestSeats = true, includeNames = true } = options;
    const subj = CFG.SUBJECTS.find((s) => s.id === subjectId);
    const assessments = store.getSubjectAssessments(subjectId);
    const seats = store.getSeats().filter((s) => includeTestSeats || !store.isTestSeat(s));
    const stats = store.computeSubjectStats(subjectId);

    const headers = ["座號", "身份標記"];
    if (includeNames) headers.push("姓名");
    for (const a of assessments) {
      headers.push(`${subj.name}-${a.title}`);
    }
    headers.push("小考平均", "期中平均", "期末平均", "科目平均");

    const rows = [headers];

    for (const seat of seats) {
      const sum = store.computeStudentSubjectSummary(seat, subjectId);
      const roleLabel = store.isTestSeat(seat)
        ? "測試座號"
        : store.isInactiveSeat(seat)
          ? "空號/轉出"
          : "正式學生";
      const row = [seat, roleLabel];
      if (includeNames) row.push(store.getSeatName(seat, false));

      for (const a of assessments) {
        row.push(formatCellForCsvExport(a.scores[String(seat)]));
      }

      row.push(
        sum.quizAvg ?? "",
        sum.midtermAvg ?? "",
        sum.finalAvg ?? "",
        sum.subjectAvg ?? "",
      );
      rows.push(row);
    }

    // 底部統計列
    const statLabelNote = store.getState().settings.includeTestInStats ? "班級平均(含測試)" : "班級平均(不含測試)";
    const avgRow = [statLabelNote, ""];
    const maxRow = ["最高分", ""];
    const minRow = ["最低分", ""];
    if (includeNames) {
      avgRow.push("");
      maxRow.push("");
      minRow.push("");
    }
    for (const a of assessments) {
      const st = stats.perAssessment[a.id];
      avgRow.push(st?.avg ?? "");
      maxRow.push(st?.max ?? "");
      minRow.push(st?.min ?? "");
    }
    avgRow.push(
      stats.quizStats.avg ?? "",
      stats.midtermStats.avg ?? "",
      stats.finalStats.avg ?? "",
      stats.subjectAvgStats.avg ?? "",
    );
    maxRow.push(
      stats.quizStats.max ?? "",
      stats.midtermStats.max ?? "",
      stats.finalStats.max ?? "",
      stats.subjectAvgStats.max ?? "",
    );
    minRow.push(
      stats.quizStats.min ?? "",
      stats.midtermStats.min ?? "",
      stats.finalStats.min ?? "",
      stats.subjectAvgStats.min ?? "",
    );

    rows.push(avgRow, maxRow, minRow);
    return toCsvString(rows);
  }

  function exportOverviewCsv(store, options = {}) {
    const { includeTestSeats = true, includeNames = true, metric = "subjectAvg" } = options;
    const overview = store.computeAllSubjectsOverview();
    const filteredRows = overview.rows.filter((r) => includeTestSeats || !r.isTestSeat);

    const headers = ["座號", "身份標記"];
    if (includeNames) headers.push("姓名");

    if (metric === "all_details") {
      for (const subj of CFG.SUBJECTS) {
        headers.push(`${subj.name}-小考平均`, `${subj.name}-期中考`, `${subj.name}-期末考`, `${subj.name}-科目平均`);
      }
    } else {
      const suffix =
        metric === "quiz"
          ? "小考平均"
          : metric === "midterm"
            ? "期中考"
            : metric === "final"
              ? "期末考"
              : "科目平均";
      for (const subj of CFG.SUBJECTS) {
        headers.push(`${subj.name}-${suffix}`);
      }
    }
    headers.push("總平均", "班級參考排名", "未及格科數");

    const rows = [headers];
    for (const r of filteredRows) {
      const roleLabel = r.isTestSeat ? "測試座號" : r.isInactive ? "空號/轉出" : "正式學生";
      const row = [r.seat, roleLabel];
      if (includeNames) row.push(r.name || "");

      for (const subj of CFG.SUBJECTS) {
        const s = r.bySubject[subj.id];
        if (metric === "all_details") {
          row.push(s.quizAvg ?? "", s.midtermAvg ?? "", s.finalAvg ?? "", s.subjectAvg ?? "");
        } else if (metric === "quiz") {
          row.push(s.quizAvg ?? "");
        } else if (metric === "midterm") {
          row.push(s.midtermAvg ?? "");
        } else if (metric === "final") {
          row.push(s.finalAvg ?? "");
        } else {
          row.push(s.subjectAvg ?? "");
        }
      }

      row.push(
        r.overallAvg ?? "",
        r.isTestSeat ? "測試不計名" : (r.rank ?? ""),
        r.failedCount,
      );
      rows.push(row);
    }

    // 班級平均列
    const avgRow = ["班級平均", ""];
    if (includeNames) avgRow.push("");
    for (const subj of CFG.SUBJECTS) {
      const st = overview.subjectStats[subj.id];
      if (metric === "all_details") {
        avgRow.push(
          st.quizStats.avg ?? "",
          st.midtermStats.avg ?? "",
          st.finalStats.avg ?? "",
          st.subjectAvgStats.avg ?? "",
        );
      } else if (metric === "quiz") {
        avgRow.push(st.quizStats.avg ?? "");
      } else if (metric === "midterm") {
        avgRow.push(st.midtermStats.avg ?? "");
      } else if (metric === "final") {
        avgRow.push(st.finalStats.avg ?? "");
      } else {
        avgRow.push(st.subjectAvgStats.avg ?? "");
      }
    }
    avgRow.push(overview.overallStats.avg ?? "", "", "");
    rows.push(avgRow);

    return toCsvString(rows);
  }

  function exportLongCsv(store, options = {}) {
    const { includeTestSeats = true, includeNames = true } = options;
    const state = store.getState();
    const seats = store.getSeats().filter((s) => includeTestSeats || !store.isTestSeat(s));

    const headers = ["座號", "身份標記"];
    if (includeNames) headers.push("姓名");
    headers.push("科目", "成績類別", "評量名稱", "日期", "滿分", "分數", "備註");

    const rows = [headers];
    for (const subj of CFG.SUBJECTS) {
      const assessments = store.getSubjectAssessments(subj.id);
      for (const a of assessments) {
        const catName = CFG.CATEGORIES.find((c) => c.id === a.category)?.name || a.category;
        for (const seat of seats) {
          const val = a.scores[String(seat)];
          const note = a.notes[String(seat)] || "";
          if (val === undefined && !note) continue;
          const roleLabel = store.isTestSeat(seat) ? "測試座號" : "正式學生";
          const row = [seat, roleLabel];
          if (includeNames) row.push(store.getSeatName(seat, false));
          row.push(subj.name, catName, a.title, a.date || "", a.maxScore, formatCellForCsvExport(val), note);
          rows.push(row);
        }
      }
    }

    return toCsvString(rows);
  }

  function generateTemplateCsv(templateType, store, subjectId = "chinese") {
    const seats = store.getSeats();
    const subj = CFG.SUBJECTS.find((s) => s.id === subjectId) || CFG.SUBJECTS[0];

    if (templateType === "quick_two_col") {
      const rows = [["座號", "姓名", "分數"]];
      for (const s of seats) {
        const name = store.getSeatName(s, false) || (store.isTestSeat(s) ? "(測試座號)" : "");
        rows.push([s, name, ""]);
      }
      return toCsvString(rows);
    }

    if (templateType === "subject_wide") {
      const rows = [["座號", "姓名", `${subj.name}-第1次小考`, `${subj.name}-第2次小考`, `${subj.name}-期中考`, `${subj.name}-期末考`]];
      for (const s of seats) {
        const name = store.getSeatName(s, false) || (store.isTestSeat(s) ? "(測試座號)" : "");
        rows.push([s, name, "", "", "", ""]);
      }
      return toCsvString(rows);
    }

    // long_all: 示範多科明細格式（含 29 號測試座號範例與 1~28 號小考空白範本）
    const rows = [["座號", "姓名", "科目", "成績類別", "評量名稱", "日期", "滿分", "分數", "備註"]];
    for (const sub of CFG.SUBJECTS) {
      rows.push([29, store.getSeatName(29, false) || "測試座號", sub.name, "小考", "第1次小考", "", 100, 90, "測試範例"]);
      rows.push([29, store.getSeatName(29, false) || "測試座號", sub.name, "期中考", "期中考", "", 100, 88, "測試範例"]);
      rows.push([29, store.getSeatName(29, false) || "測試座號", sub.name, "期末考", "期末考", "", 100, 92, "測試範例"]);
    }
    for (const s of seats) {
      if (store.isTestSeat(s)) continue;
      rows.push([s, store.getSeatName(s, false), subj.name, "小考", "第1次小考", "", 100, "", ""]);
    }
    return toCsvString(rows);
  }

  const exported = {
    decodeFileBuffer,
    parseDelimitedText,
    parseSeatToken,
    matchSubject,
    matchCategory,
    inferCategoryFromTitle,
    parseHeaderDescriptor,
    analyzeCsvRows,
    buildImportPreview,
    exportSubjectCsv,
    exportOverviewCsv,
    exportLongCsv,
    generateTemplateCsv,
    toCsvString,
    formatRawScoreForDisplay,
  };

  global.GradeCsv = exported;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})(typeof window !== "undefined" ? window : globalThis);
