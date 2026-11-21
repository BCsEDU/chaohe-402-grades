const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

function loadAppModules() {
  const storage = createMemoryStorage();
  global.window = global;
  global.localStorage = storage;

  const baseDir = path.resolve(__dirname, "..", "js");
  require(path.join(baseDir, "config.js"));
  require(path.join(baseDir, "store.js"));
  require(path.join(baseDir, "csv.js"));
  return { context: global, storage };
}

function runTests() {
  const { context } = loadAppModules();
  const CFG = context.GRADE_CONFIG;
  const store = context.GradeStoreFactory.createStore(context.localStorage);
  const csv = context.GradeCsv;

  // 1. 檢查預設 1~29 號、29 號為測試座號、6 個科目、3 個類別（無權重與等第設定）
  assert.equal(store.getSeats().length, 29);
  assert.equal(store.isTestSeat(29), true);
  assert.equal(store.isTestSeat(28), false);
  assert.equal(store.isSeatIncludedInStats(29), false);
  assert.equal(CFG.GRADE_TIERS, undefined);
  assert.equal(CFG.WEIGHT_PRESETS, undefined);
  assert.deepEqual(
    CFG.SUBJECTS.map((s) => s.name),
    ["國語", "數學", "綜合", "體育", "彈性", "校本"],
  );
  assert.deepEqual(
    CFG.CATEGORIES.map((c) => c.name),
    ["小考", "期中考", "期末考"],
  );

  // 2. 檢查各科預設擁有 小考 / 期中考 / 期末考 三個起始評量
  for (const subj of CFG.SUBJECTS) {
    const list = store.getSubjectAssessments(subj.id);
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((a) => a.category),
      ["quiz", "midterm", "final"],
    );
  }

  // 3. 驗證 29 號測試座號成績不影響班級平均
  const chQuiz = store.getSubjectAssessments("chinese", "quiz")[0];
  const chMid = store.getSubjectAssessments("chinese", "midterm")[0];
  const chFin = store.getSubjectAssessments("chinese", "final")[0];

  assert.equal(store.setScore(chQuiz.id, 1, "80").valid, true);
  assert.equal(store.setScore(chQuiz.id, 2, "90").valid, true);
  assert.equal(store.setScore(chQuiz.id, 29, "10").valid, true);

  let stats = store.computeSubjectStats("chinese");
  assert.equal(stats.quizStats.avg, 85);
  assert.equal(stats.quizStats.count, 2);

  store.updateSettings({ includeTestInStats: true });
  stats = store.computeSubjectStats("chinese");
  assert.equal(stats.quizStats.avg, 60);
  assert.equal(stats.quizStats.count, 3);
  store.updateSettings({ includeTestInStats: false });

  // 4. 驗證無加權單純算術平均（小考平均 + 期中考 + 期末考 直接平均）
  store.setScore(chMid.id, 1, "90");
  const partialSum = store.computeStudentSubjectSummary(1, "chinese");
  // (80 + 90) / 2 = 85
  assert.equal(partialSum.subjectAvg, 85);

  store.setScore(chFin.id, 1, "100");
  const fullSum = store.computeStudentSubjectSummary(1, "chinese");
  // (80 + 90 + 100) / 3 = 90
  assert.equal(fullSum.subjectAvg, 90);
  assert.equal(fullSum.tier, undefined);

  // 5. 驗證多次自行新增小考 + 滿分 50 分自動換算 + 缺考處理
  const chQuiz2 = store.addAssessment({ subjectId: "chinese", category: "quiz", title: "L2聽寫", maxScore: 50 });
  store.setScore(chQuiz2.id, 1, "45"); // 45/50 -> 90
  const sumAfterQ2 = store.computeStudentSubjectSummary(1, "chinese");
  assert.equal(sumAfterQ2.quizAvg, 85); // (80 + 90)/2 = 85
  // (85 + 90 + 100) / 3 = 91.7
  assert.equal(sumAfterQ2.subjectAvg, 91.7);

  store.setScore(chQuiz2.id, 2, "缺");
  const sumSeat2 = store.computeStudentSubjectSummary(2, "chinese");
  assert.equal(sumSeat2.absentCount, 1);
  assert.equal(sumSeat2.quizAvg, 90);

  // 6. 測試兩欄極速 CSV 上傳匯入
  const twoColText = "1, 95\n2, 85\n29, 99\n35, 70\n3, abc";
  const parsedTwo = csv.parseDelimitedText(twoColText);
  const analysisTwo = csv.analyzeCsvRows(parsedTwo.rows, store, { defaultSubjectId: "math" });
  assert.equal(analysisTwo.mode, "two_col");

  const mathQuiz = store.getSubjectAssessments("math", "quiz")[0];
  const previewTwo = csv.buildImportPreview(analysisTwo, store, {
    targetSubjectId: "math",
    targetCategory: "quiz",
    targetAssessmentId: mathQuiz.id,
    includeTestSeats: true,
    overwriteExisting: true,
  });
  assert.equal(previewTwo.stats.totalOps, 3);
  assert.equal(previewTwo.stats.testSeatCount, 1);
  assert.equal(previewTwo.warnings.length, 2);

  const importRes = store.applyImportOperations(previewTwo.operations, {
    overwriteExisting: true,
    includeTestSeats: true,
  });
  assert.equal(importRes.addedCount, 3);
  assert.equal(store.computeStudentSubjectSummary(29, "math").quizAvg, 99);

  // 7. 測試復原匯入前快照
  assert.equal(store.restorePreImportSnapshot(), true);
  assert.equal(store.computeStudentSubjectSummary(29, "math").quizAvg, null);

  // 8. 測試匯出單科 CSV 不含等第/加權，且可直接重新匯入
  const exportedSubjCsv = csv.exportSubjectCsv(store, "chinese", { includeTestSeats: true, includeNames: false });
  assert.ok(exportedSubjCsv.startsWith("\uFEFF"));
  assert.equal(exportedSubjCsv.includes("等第"), false);
  assert.equal(exportedSubjCsv.includes("加權"), false);
  const parsedSubj = csv.parseDelimitedText(exportedSubjCsv);
  const analysisSubj = csv.analyzeCsvRows(parsedSubj.rows, store, { defaultSubjectId: "chinese" });
  assert.equal(analysisSubj.mode, "wide");
  const importedCols = analysisSubj.columnMappings.filter((m) => m.action === "import");
  assert.equal(importedCols.length, 4);

  const previewSubj = csv.buildImportPreview(analysisSubj, store, {
    columnMappings: analysisSubj.columnMappings,
    overwriteExisting: true,
    includeTestSeats: true,
  });
  assert.equal(previewSubj.warnings.length, 0);
  assert.ok(previewSubj.operations.length > 0);
  assert.equal(previewSubj.stats.updateCount, 0);

  // 9. 測試完整明細匯出 -> 清空後無損還原
  const beforeSeat1Chinese = store.computeStudentSubjectSummary(1, "chinese");
  const longCsv = csv.exportLongCsv(store, { includeTestSeats: true, includeNames: true });
  store.resetAllData();
  assert.equal(store.computeStudentSubjectSummary(1, "chinese").subjectAvg, null);

  const parsedLong = csv.parseDelimitedText(longCsv);
  const analysisLong = csv.analyzeCsvRows(parsedLong.rows, store);
  assert.equal(analysisLong.mode, "long");
  const previewLong = csv.buildImportPreview(analysisLong, store, {
    overwriteExisting: true,
    includeTestSeats: true,
  });
  store.applyImportOperations(previewLong.operations, { overwriteExisting: true, includeTestSeats: true });
  const restoredSeat1Chinese = store.computeStudentSubjectSummary(1, "chinese");
  assert.equal(restoredSeat1Chinese.subjectAvg, beforeSeat1Chinese.subjectAvg);
  assert.equal(restoredSeat1Chinese.quizAvg, beforeSeat1Chinese.quizAvg);

  // 10. 測試不含 29 號匯出與全科排名（且匯出無等第/加權）
  store.loadClassDemoData();
  const overview = store.computeAllSubjectsOverview();
  const seat29Row = overview.rows.find((r) => r.seat === 29);
  assert.equal(seat29Row.isTestSeat, true);
  assert.equal(seat29Row.rank, null);
  assert.equal(overview.rows.filter((r) => r.rank !== null).length, 28);

  const exportNoTest = csv.exportOverviewCsv(store, { includeTestSeats: false, includeNames: true });
  assert.equal(exportNoTest.includes("等第"), false);
  assert.equal(exportNoTest.includes("加權"), false);
  const parsedNoTest = csv.parseDelimitedText(exportNoTest);
  assert.equal(parsedNoTest.rows.length, 30);

  // 11. 測試 Big5 編碼解碼
  const big5Buf = Uint8Array.from([
    0xae, 0x79, 0xb8, 0xb9, 0x2c, 0xa4, 0xc0, 0xbc, 0xc6, 0x0d, 0x0a, 0x31, 0x2c, 0x39, 0x35,
  ]).buffer;
  const decoded = csv.decodeFileBuffer(big5Buf);
  assert.equal(decoded.encoding, "Big5");
  assert.equal(decoded.text, "座號,分數\r\n1,95");

  // 12. 測試 Numbers 雙列標題合併、忽略姓名欄、重複欄名 (L2 / L2) 區分、及 X 免考標記
  store.resetAllData();
  const numbersStyleText = [
    ",,L1,L2,L2,期中考",
    "座號,姓名,,,,",
    "1,隱藏A,99,60,100,96",
    "3,隱藏B,X,84,84,82",
  ].join("\n");
  const parsedNum = csv.parseDelimitedText(numbersStyleText);
  const analysisNum = csv.analyzeCsvRows(parsedNum.rows, store, { defaultSubjectId: "math" });
  assert.equal(analysisNum.mode, "wide");
  const activeCols = analysisNum.columnMappings.filter((m) => m.role === "score" && m.action === "import");
  assert.deepEqual(
    activeCols.map((c) => c.title),
    ["L1", "L2 (1)", "L2 (2)", "期中考"],
  );
  const previewNum = csv.buildImportPreview(analysisNum, store, {
    columnMappings: analysisNum.columnMappings,
    overwriteExisting: true,
    includeTestSeats: true,
  });
  assert.equal(previewNum.warnings.length, 0);
  assert.equal(previewNum.stats.totalOps, 8);
  store.applyImportOperations(previewNum.operations, { overwriteExisting: true, includeTestSeats: true });
  assert.equal(Object.keys(store.getState().names).length, 0); // 姓名欄完全忽略，未寫入 names
  assert.equal(store.getSubjectAssessments("math", "quiz").some((a) => a.id === "math_quiz_1"), false); // 空白預設第1次小考已自動清理
  const seat3Math = store.computeStudentSubjectSummary(3, "math");
  // L1=EXEMPT(不計), L2(1)=84, L2(2)=84 -> quizAvg=84, 期中考=82 -> subjectAvg=83
  assert.equal(seat3Math.quizAvg, 84);
  assert.equal(seat3Math.subjectAvg, 83);

  // 13. 測試直欄鎖定功能（防止手動修改、批量調分、刪除、與 CSV 匯入覆蓋）
  const chMidExam = store.getSubjectAssessments("chinese", "midterm")[0];
  store.setScore(chMidExam.id, 1, "95");
  store.toggleAssessmentLock(chMidExam.id);
  assert.equal(store.getSubjectAssessments("chinese", "midterm")[0].locked, true);
  assert.equal(store.setScore(chMidExam.id, 1, "50").valid, false);
  assert.equal(store.getSubjectAssessments("chinese", "midterm")[0].scores["1"], 95);
  assert.equal(store.bulkAdjustAssessment(chMidExam.id, "add", 5), 0);
  assert.equal(store.deleteAssessment(chMidExam.id), false);

  const lockedCsvPreview = csv.buildImportPreview(
    csv.analyzeCsvRows(csv.parseDelimitedText("座號,分數\n1,60").rows, store, { defaultSubjectId: "chinese" }),
    store,
    { targetSubjectId: "chinese", targetCategory: "midterm", targetAssessmentId: chMidExam.id },
  );
  assert.equal(lockedCsvPreview.operations.length, 0);
  assert.equal(lockedCsvPreview.warnings.length, 1);

  // 14. 測試學生協助登打模式（僅開放科目/新增考試/未鎖定成績輸入，其餘鎖定＋PIN 保護）
  const helperQuiz = store.addAssessment({ subjectId: "chinese", category: "quiz", title: "學生協助輸入小考" });
  store.setStudentHelperMode(true, "4020");
  assert.equal(store.getState().settings.studentHelperMode, true);

  // 開放：新增考試項目、成績輸入（未鎖定）
  const helperAdded = store.addAssessment({ subjectId: "pe", category: "quiz", title: "體適能仰臥起坐" });
  assert.ok(helperAdded.id);
  assert.equal(store.setScore(helperAdded.id, 1, "92").valid, true);
  assert.equal(store.setScore(helperQuiz.id, 2, "88").valid, true);

  // 禁止：修改已鎖定欄、解鎖、改名/刪除欄位、大量調整、CSV匯入、改設定、重置
  assert.equal(store.setScore(chMidExam.id, 1, "10").valid, false);
  assert.equal(store.toggleAssessmentLock(chMidExam.id), null);
  assert.equal(store.updateAssessment(helperQuiz.id, { title: "偷改名" }), null);
  assert.equal(store.deleteAssessment(helperQuiz.id), false);
  assert.equal(store.bulkAdjustAssessment(helperQuiz.id, "clear"), 0);
  assert.equal(store.setNamesMap({ "1": "偷看" }), false);
  assert.equal(store.restorePreImportSnapshot(), false);

  // 錯誤密碼無法解除，正確密碼解除成功
  assert.equal(store.setStudentHelperMode(false, "1234").ok, false);
  assert.equal(store.getState().settings.studentHelperMode, true);
  assert.equal(store.setStudentHelperMode(false, "4020").ok, true);
  assert.equal(store.getState().settings.studentHelperMode, false);

  // 解除後可解鎖原鎖定欄位
  store.toggleAssessmentLock(chMidExam.id);
  assert.equal(store.setScore(chMidExam.id, 1, "96").valid, true);

  console.log("ALL 14 LOCAL TESTS PASSED, RUNNING SUITE 15 CLOUD SYNC TESTS...");
}

async function runCloudTests() {
  const { context } = loadAppModules();
  const calls = [];
  let failNextSetScore = false;

  context.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });

    if (body.action === "helper_get_state") {
      if (body.helper_pin !== "4020") {
        return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          role: "helper",
          settings: {
            className: "402 班",
            semesterName: "115 學年度第 1 學期",
            maxSeat: 29,
            testSeats: [29],
            inactiveSeats: [],
            includeTestInStats: false,
            absentMode: "exclude",
            studentHelperMode: true,
            helperEnabled: true,
          },
          assessments: [
            {
              id: "chinese_quiz_1",
              subjectId: "chinese",
              category: "quiz",
              title: "第1次小考",
              date: "",
              maxScore: 100,
              order: 1,
              locked: false,
              scores: { "1": 85 },
              notes: {},
            },
            {
              id: "chinese_midterm_1",
              subjectId: "chinese",
              category: "midterm",
              title: "期中考",
              date: "",
              maxScore: 100,
              order: 2,
              locked: true,
              scores: { "1": 90 },
              notes: {},
            },
          ],
          serverTime: "2026-11-21T04:25:00Z",
        }),
      };
    }

    if (body.action === "helper_add_assessment") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          assessment: {
            id: "math_quiz_cloud_1",
            subjectId: body.subjectId,
            category: body.category,
            title: body.title || "第1次小考",
            date: "",
            maxScore: body.maxScore || 100,
            order: 99,
            locked: false,
            scores: {},
            notes: {},
          },
        }),
      };
    }

    if (body.action === "helper_set_score") {
      if (failNextSetScore) {
        return { ok: false, status: 403, json: async () => ({ error: "此欄位已鎖定，請教師先解除鎖定" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: body.value }) };
    }

    return { ok: false, status: 400, json: async () => ({ error: "bad" }) };
  };

  const store = context.GradeStoreFactory.createStore(context.localStorage);

  // 錯誤通行碼應被拒
  await assert.rejects(() => store.connectCloudHelper("9999"), /unauthorized/);

  // 正確通行碼登入平板協助模式
  await store.connectCloudHelper("4020");
  assert.equal(store.getCloudSession().mode, "cloud_helper");
  assert.equal(store.getState().settings.studentHelperMode, true);
  assert.equal(store.getState().assessments[0].scores["1"], 85);

  // 新增雲端小考並輸入成績
  const created = await store.syncAddAssessment({ subjectId: "math", category: "quiz", title: "雲端平板小考" });
  assert.equal(created.id, "math_quiz_cloud_1");

  const okRes = await store.syncSetScore("math_quiz_cloud_1", 2, "93");
  assert.equal(okRes.valid, true);
  assert.equal(store.getState().assessments.find((a) => a.id === "math_quiz_cloud_1").scores["2"], 93);

  // 若伺服器端剛鎖定該欄（403），本地樂觀寫入應回滾並重新同步
  failNextSetScore = true;
  const failRes = await store.syncSetScore("chinese_quiz_1", 1, "55");
  assert.equal(failRes.valid, false);
  assert.equal(store.getState().assessments.find((a) => a.id === "chinese_quiz_1").scores["1"], 85);

  console.log("ALL 15 GRADE-MANAGER TEST SUITES (INCLUDING CLOUD SYNC) PASSED!");
}

runTests();
runCloudTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
