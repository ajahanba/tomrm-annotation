// ToM-RM annotation task -- client logic.
//
// Flow: landing (enter code) -> fetch data/assignment_<code>.json ->
// calibration (answer, then reveal intended answer + rationale) -> main task
// (answer, no feedback, POST each response) -> done.
//
// Progress and any responses that failed to send are kept in localStorage so
// closing the tab, losing connectivity, or a slow Apps Script cold start
// never loses data.

const CONFIG = {
  // Paste the URL you get after deploying Code.gs as a web app (see
  // DEPLOY.md). Looks like: https://script.google.com/macros/s/AKfycb.../exec
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwOtcRZ0khKG2zWJgOZjwqoVPITyEDiWU4NCtXIgrb1UEkrldDdICSPeJ9IP0tIFUID/exec",
};

const el = (id) => document.getElementById(id);
const show = (id) => { el(id).hidden = false; };
const hide = (id) => { el(id).hidden = true; };
const showOnly = (id) => {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = true));
  show(id);
};

let S = null; // session state, see loadLocal/freshState

function storageKey(code) {
  return `tomrm_annot_v1_${code}`;
}

function freshState(code, dataVersion, calibration, items) {
  return {
    code,
    dataVersion,
    calibration,
    items,
    calibIndex: 0,
    mainIndex: 0,
    pendingQueue: [], // responses not yet confirmed sent
    phase: "calib-intro", // calib-intro | calib-item | main-intro | main-item | done
  };
}

function saveLocal() {
  localStorage.setItem(storageKey(S.code), JSON.stringify(S));
}

function loadLocal(code) {
  try {
    const raw = localStorage.getItem(storageKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function postRecord(record) {
  try {
    const resp = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(record),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

async function flushQueue() {
  if (!S.pendingQueue.length) return;
  const remaining = [];
  for (const record of S.pendingQueue) {
    const ok = await postRecord(record);
    if (!ok) remaining.push(record);
  }
  S.pendingQueue = remaining;
  saveLocal();
}

async function sendResponse(record) {
  S.pendingQueue.push(record);
  saveLocal();
  await flushQueue();
}

// ---------- landing ----------

function initLanding() {
  const params = new URLSearchParams(location.search);
  const codeFromUrl = params.get("code");
  if (codeFromUrl) el("code-input").value = codeFromUrl;

  el("start-btn").addEventListener("click", startSession);
  el("code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSession();
  });
}

async function startSession() {
  const code = el("code-input").value.trim();
  if (!code) {
    el("landing-error").hidden = false;
    el("landing-error").textContent = "Please enter your annotator code.";
    return;
  }

  let data;
  try {
    const resp = await fetch(`data/assignment_${code}.json`);
    if (!resp.ok) throw new Error("not found");
    data = await resp.json();
  } catch (e) {
    el("landing-error").hidden = false;
    el("landing-error").textContent =
      `Couldn't find an assignment for code "${code}". Check the code and try again.`;
    return;
  }

  const existing = loadLocal(code);
  if (existing && existing.dataVersion === data.data_version) {
    // Same task data as before -- resume where this browser left off.
    S = existing;
    resumeUI();
    return;
  }

  if (existing) {
    // The underlying task data changed since this browser last saved
    // progress here (e.g. the sample or roster was regenerated). Flush
    // whatever hadn't been sent yet, then start clean on the new data --
    // old progress markers don't mean anything against a different item set.
    S = existing;
    await flushQueue();
  }

  S = freshState(code, data.data_version, data.calibration, data.items);
  saveLocal();
  resumeUI();
}

function resumeUI() {
  if (S.phase === "calib-intro") renderCalibIntro();
  else if (S.phase === "calib-item") renderCalibItem();
  else if (S.phase === "main-intro") renderMainIntro();
  else if (S.phase === "main-item") renderMainItem();
  else if (S.phase === "done") renderDone();
}

// ---------- calibration ----------

function renderCalibIntro() {
  S.phase = "calib-intro";
  saveLocal();
  el("calib-count").textContent = S.calibration.length;
  el("calib-start-btn").onclick = () => {
    S.phase = "calib-item";
    S.calibIndex = 0;
    saveLocal();
    renderCalibItem();
  };
  showOnly("screen-calib-intro");
}

function renderCalibItem() {
  if (S.calibIndex >= S.calibration.length) {
    renderMainIntro();
    return;
  }
  const item = S.calibration[S.calibIndex];
  el("calib-progress").textContent =
    `Calibration ${S.calibIndex + 1} of ${S.calibration.length}`;
  el("calib-construct-q").textContent = item.construct_question;
  el("calib-context").textContent = item.context;
  el("calib-question").textContent = item.question_block;
  el("calib-traj").textContent = item.trajectory_text;
  el("calib-gold").textContent = item.gold_answer;

  show("calib-answer-row");
  hide("calib-reveal");

  const buttons = document.querySelectorAll("#calib-answer-row .ans-btn");
  buttons.forEach((btn) => {
    btn.onclick = () => {
      hide("calib-answer-row");
      el("calib-reveal-answer").textContent = item.suggested_answer;
      el("calib-reveal-rationale").textContent = item.rationale;
      show("calib-reveal");

      sendResponse({
        annotator: S.code,
        phase: "calibration",
        uid: item.uid,
        metric: item.metric,
        answer: btn.dataset.ans,
        suggested_answer: item.suggested_answer,
        ts: new Date().toISOString(),
      });
    };
  });

  el("calib-next-btn").onclick = () => {
    S.calibIndex += 1;
    saveLocal();
    renderCalibItem();
  };

  showOnly("screen-calib-item");
}

// ---------- main task ----------

function renderMainIntro() {
  S.phase = "main-intro";
  saveLocal();
  el("main-count").textContent = S.items.length;
  el("main-start-btn").onclick = () => {
    S.phase = "main-item";
    saveLocal();
    renderMainItem();
  };
  showOnly("screen-main-intro");
}

function renderMainItem() {
  if (S.mainIndex >= S.items.length) {
    renderDone();
    return;
  }
  const item = S.items[S.mainIndex];
  el("main-progress").textContent =
    `Item ${S.mainIndex + 1} of ${S.items.length}`;
  el("main-construct-q").textContent = item.construct_question;
  el("main-context").textContent = item.context;
  el("main-question").textContent = item.question_block;
  el("main-traj").textContent = item.trajectory_text;
  el("main-gold").textContent = item.gold_answer;
  hide("main-sending");

  const buttons = document.querySelectorAll("#main-answer-row .ans-btn");
  buttons.forEach((btn) => {
    btn.onclick = async () => {
      buttons.forEach((b) => (b.disabled = true));
      show("main-sending");

      await sendResponse({
        annotator: S.code,
        phase: "main",
        uid: item.uid,
        metric: item.metric,
        answer: btn.dataset.ans,
        ts: new Date().toISOString(),
      });

      buttons.forEach((b) => (b.disabled = false));
      S.mainIndex += 1;
      saveLocal();
      renderMainItem();
    };
  });

  showOnly("screen-main-item");
}

function renderDone() {
  S.phase = "done";
  saveLocal();
  el("done-count").textContent = S.items.length;
  if (S.pendingQueue.length) {
    el("done-pending-note").hidden = false;
    el("done-pending-note").textContent =
      `Still trying to save ${S.pendingQueue.length} response(s) in the background -- ` +
      `please keep this tab open a little longer if you can.`;
    flushQueue().then(() => {
      if (!S.pendingQueue.length) el("done-pending-note").hidden = true;
    });
  }
  showOnly("screen-done");
}

// ---------- boot ----------

initLanding();
showOnly("screen-landing");
