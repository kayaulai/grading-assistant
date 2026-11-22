/* Grading assistant.

   Grade one student-and-question answer at a time. Every issue you write is kept
   as a "canned issue" (unless you tick Student-specific), so you can pick it from
   a list the next time the same mistake turns up and it gets the same comment and
   the same deduction.

   All data stays in this browser: it autosaves to localStorage and can be
   exported to / imported from JSON files. Nothing is sent anywhere. */
(function () {
  "use strict";

  var STORE_KEY = "grading-assistant/session/v1";
  var FMT = {
    session: "grading-assistant/session",
    general: "grading-assistant/general-issues",
    question: "grading-assistant/question-issues",
    rubric: "grading-assistant/rubric"
  };

  var S = null;            // the session being graded
  var screen = "start";
  var reviewQ = null;      // question shown on the review screen
  var libFilter = "all";
  var form = { cannedId: null, editingId: null };
  var pendingImports = { general: null, question: null }; // files picked on the new-assignment form

  /* ================= Helpers ================= */

  function $(id) { return document.getElementById(id); }

  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") e.addEventListener(k.slice(2), v);
        else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden") e[k] = v;
        else e.setAttribute(k, v === true ? "" : String(v));
      });
    }
    var kids = Array.prototype.slice.call(arguments, 2);
    (function add(list) {
      list.forEach(function (kid) {
        if (kid == null || kid === false) return;
        if (Array.isArray(kid)) add(kid);
        else e.append(kid instanceof Node ? kid : String(kid));
      });
    })(kids);
    return e;
  }

  function isNum(n) { return typeof n === "number" && isFinite(n); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmt(n) { return String(round2(n)); }
  function minus(n) { return (n > 0 ? "−" : "") + fmt(n); }
  function norm(t) { return String(t).replace(/\s+/g, " ").trim().toLowerCase(); }
  function trunc(t, n) {
    var s = String(t).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function lines(t) { return String(t).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "assignment"; }
  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  function timeStr(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "an unknown time" :
      d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function listText(arr, max) {
    max = max || 6;
    return arr.slice(0, max).join(", ") + (arr.length > max ? " and " + (arr.length - max) + " more" : "");
  }
  function duplicates(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) {
      var k = "k" + norm(x);
      if (seen[k] && out.indexOf(x) < 0) out.push(x);
      seen[k] = true;
    });
    return out;
  }

  var announceTimer = null;
  function announce(msg) {
    var live = $("live");
    live.textContent = "";
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () { live.textContent = msg; }, 60);
  }

  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function readJson(file) {
    return file.text().then(function (text) {
      try { return JSON.parse(text); }
      catch (e) { throw new Error("That file isn't valid JSON, so it can't be opened."); }
    }, function () { throw new Error("That file couldn't be read."); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var back = document.activeElement;
    var ta = h("textarea", { class: "visually-hidden", "aria-hidden": "true", tabindex: "-1" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    if (back && back.focus) back.focus();
    return ok;
  }

  function fillSelect(sel, items, value) {
    sel.replaceChildren.apply(sel, items.map(function (it) {
      return typeof it === "string" ? h("option", { value: it, text: it }) : h("option", { value: it.value, text: it.label });
    }));
    sel.value = value;
    if (sel.value !== value && sel.options.length) sel.selectedIndex = 0;
  }

  /* ---------- Dialog: ask(title, paragraphs, buttons) -> Promise<value or null> ---------- */
  function ask(title, body, buttons) {
    return new Promise(function (resolve) {
      var d = $("dlg");
      var back = document.activeElement;
      $("dlg-title").textContent = title;
      $("dlg-body").replaceChildren.apply($("dlg-body"), [].concat(body).map(function (x) {
        return typeof x === "string" ? h("p", { text: x }) : x;
      }));
      var row = $("dlg-buttons");
      row.replaceChildren();
      function finish(v) {
        d.removeEventListener("cancel", onCancel);
        d.close();
        if (back && document.contains(back) && back.focus) back.focus();
        resolve(v);
      }
      function onCancel(e) { e.preventDefault(); finish(null); }
      buttons.forEach(function (b) {
        row.append(h("button", {
          type: "button", class: "btn " + (b.kind || "btn-outline"), text: b.label,
          onclick: function () { finish(b.value); }
        }));
      });
      d.addEventListener("cancel", onCancel);
      d.showModal();
      row.querySelector("button").focus();
    });
  }

  /* ================= Session data ================= */

  function newState(v) {
    return {
      format: FMT.session, version: 1,
      assignment: v.assignment,
      students: v.students.slice(),
      questions: v.questions.slice(),
      rubric: v.rubric.map(function (r) { return { name: r.name, max: r.max }; }),
      canned: [],      // {id, text, rubric, points, scope: "unreviewed"|"question"|"general", question}
      records: [],     // {question, student, status: "open"|"graded", issues: [...]}
      reviewed: [],    // questions whose canned issues have been sorted
      prefs: { autoCopy: false },
      position: { question: v.questions[0], student: v.students[0] },
      createdAt: new Date().toISOString(),
      savedAt: null,
      exportedAt: null,
      exportDirty: true
    };
  }

  function normalizeSession(o) {
    if (!o || typeof o !== "object") throw new Error("That file is empty or unreadable.");
    if (o.format === FMT.general || o.format === FMT.question) {
      throw new Error("That's a canned-issues file, not a full session. Import it in the “Bring in canned issues” boxes when starting a new assignment, or on the Canned issues page.");
    }
    if (o.format === FMT.rubric) {
      throw new Error("That's a rubric file, not a full session. Load it in the Rubric columns section when starting a new assignment, or on the Setup page.");
    }
    if (o.format !== FMT.session) throw new Error("That isn't a session file from the grading assistant.");
    var strs = function (a) { return Array.isArray(a) && a.length && a.every(function (x) { return typeof x === "string" && x.trim(); }); };
    if (typeof o.assignment !== "string" || !strs(o.students) || !strs(o.questions) || !Array.isArray(o.rubric) ||
        !o.rubric.length || !o.rubric.every(function (r) { return r && typeof r.name === "string" && r.name.trim(); })) {
      throw new Error("This session file is missing its students, questions or rubric columns.");
    }
    var s = {
      format: FMT.session, version: 1,
      assignment: o.assignment,
      students: o.students.slice(),
      questions: o.questions.slice(),
      rubric: o.rubric.map(function (r) { return { name: r.name, max: isNum(r.max) && r.max >= 0 ? r.max : null }; }),
      canned: (Array.isArray(o.canned) ? o.canned : []).filter(function (c) {
        return c && typeof c.text === "string" && c.text.trim() && typeof c.rubric === "string" && isNum(c.points);
      }).map(function (c) {
        var scope = ["general", "question", "unreviewed"].indexOf(c.scope) >= 0 ? c.scope : "general";
        var q = typeof c.question === "string" ? c.question : null;
        if (!q && scope !== "general") scope = "general";
        return { id: typeof c.id === "string" ? c.id : uid("c"), text: c.text, rubric: c.rubric, points: c.points, scope: scope, question: q };
      }),
      records: (Array.isArray(o.records) ? o.records : []).filter(function (r) {
        return r && typeof r.question === "string" && typeof r.student === "string";
      }).map(function (r) {
        return {
          question: r.question, student: r.student,
          status: r.status === "graded" ? "graded" : "open",
          issues: (Array.isArray(r.issues) ? r.issues : []).filter(function (i) {
            return i && typeof i.text === "string" && typeof i.rubric === "string" && isNum(i.points);
          }).map(function (i) {
            return {
              id: typeof i.id === "string" ? i.id : uid("i"), text: i.text, rubric: i.rubric, points: i.points,
              cannedId: typeof i.cannedId === "string" ? i.cannedId : null, studentSpecific: !!i.studentSpecific
            };
          })
        };
      }),
      reviewed: Array.isArray(o.reviewed) ? o.reviewed.filter(function (q) { return typeof q === "string"; }) : [],
      prefs: { autoCopy: !!(o.prefs && o.prefs.autoCopy) },
      position: o.position && typeof o.position === "object" ? o.position : {},
      createdAt: o.createdAt || null,
      savedAt: o.savedAt || null,
      exportedAt: o.exportedAt || null,
      exportDirty: !!o.exportDirty
    };
    var ids = {};
    s.canned.forEach(function (c) { ids[c.id] = true; });
    s.records.forEach(function (r) { r.issues.forEach(function (i) { if (i.cannedId && !ids[i.cannedId]) i.cannedId = null; }); });
    return s;
  }

  function fixPosition() {
    var p = S.position || {};
    if (S.questions.indexOf(p.question) < 0) p.question = S.questions[0];
    if (S.students.indexOf(p.student) < 0) p.student = S.students[0];
    S.position = p;
  }

  function rec(q, s, create) {
    var r = null;
    for (var i = 0; i < S.records.length; i++) {
      if (S.records[i].question === q && S.records[i].student === s) { r = S.records[i]; break; }
    }
    if (!r && create) {
      r = { question: q, student: s, status: "open", issues: [] };
      S.records.push(r);
    }
    return r;
  }
  function statusOf(q, s) {
    var r = rec(q, s);
    if (!r) return "none";
    if (r.status === "graded") return "graded";
    return r.issues.length ? "started" : "none";
  }
  function offFor(q, s) {
    var r = rec(q, s);
    return r ? r.issues.reduce(function (a, i) { return a + i.points; }, 0) : 0;
  }
  function firstUngraded(q) {
    for (var i = 0; i < S.students.length; i++) if (statusOf(q, S.students[i]) !== "graded") return S.students[i];
    return null;
  }
  function cannedById(id) {
    for (var i = 0; i < S.canned.length; i++) if (S.canned[i].id === id) return S.canned[i];
    return null;
  }
  function visibleCanned(q) {
    return S.canned.filter(function (c) { return c.scope === "general" || c.question === q; });
  }
  function useCounts() {
    var m = {};
    S.records.forEach(function (r) {
      r.issues.forEach(function (i) { if (i.cannedId) m[i.cannedId] = (m[i.cannedId] || 0) + 1; });
    });
    return m;
  }
  function usesOf(id, except) {
    var n = 0;
    S.records.forEach(function (r) { r.issues.forEach(function (i) { if (i.cannedId === id && i !== except) n++; }); });
    return n;
  }
  function eachUse(id, fn) {
    S.records.forEach(function (r) { r.issues.forEach(function (i) { if (i.cannedId === id) fn(i, r); }); });
  }
  function rubricIdx(name) {
    for (var i = 0; i < S.rubric.length; i++) if (S.rubric[i].name === name) return i;
    return 999;
  }
  // A new canned issue that ends up used nowhere (its only answer was removed or reworded) is dropped.
  function prune() {
    var counts = useCounts();
    S.canned = S.canned.filter(function (c) { return c.scope !== "unreviewed" || counts[c.id]; });
  }

  /* ---------- Saving in the browser ---------- */
  function persist(changed) {
    if (!S) return;
    if (changed !== false) S.exportDirty = true;
    S.savedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
      $("save-status").textContent = "Saved in this browser " + timeStr(S.savedAt);
    } catch (e) {
      $("save-status").textContent = "Not saved in this browser";
      announce("This browser couldn't save your work. Use Export everything to keep it.");
    }
  }
  function loadStored() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? normalizeSession(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }
  function clearStored() { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to clear */ } }

  /* ================= Screens ================= */

  var renderers = {
    start: renderStart, grade: renderGrade, review: renderReview, progress: renderProgress,
    library: renderLibrary, report: renderReport, setup: renderSetup
  };

  function show(name, focus) {
    screen = name;
    Array.prototype.forEach.call(document.querySelectorAll(".screen"), function (sec) {
      sec.hidden = sec.id !== "screen-" + name;
    });
    Array.prototype.forEach.call(document.querySelectorAll("#app-nav [data-screen]"), function (b) {
      if (b.dataset.screen === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    renderers[name]();
    if (focus !== false) {
      var t = document.querySelector("#screen-" + name + " h2");
      if (t) t.focus();
    }
  }

  function updateChrome() {
    var on = !!S;
    $("app-nav").hidden = !on;
    $("save-area").hidden = !on;
    $("session-label").textContent = on ?
      S.assignment + ": " + plural(S.students.length, "student") + ", " + plural(S.questions.length, "question") : "";
  }

  function notice(msgs) {
    if (!msgs.length) return;
    $("notice-text").replaceChildren.apply($("notice-text"), msgs.map(function (m) { return h("p", { text: m }); }));
    $("notice").hidden = false;
    announce(msgs.join(" "));
  }

  /* ---------- Start ---------- */
  function renderStart() {
    var stored = loadStored();
    $("resume-card").hidden = !stored;
    if (stored) {
      var total = stored.students.length * stored.questions.length;
      var graded = stored.records.filter(function (r) { return r.status === "graded"; }).length;
      $("resume-summary").textContent = "“" + stored.assignment + "”: " + plural(stored.students.length, "student") + ", " +
        plural(stored.questions.length, "question") + ", " + plural(stored.canned.length, "canned issue") + ". " +
        graded + " of " + total + " answers marked graded. Last saved " + timeStr(stored.savedAt) + ".";
    }
    buildSetupForm($("new-setup"), "new");
  }

  async function replaceStoredOk(incoming) {
    var stored = loadStored();
    if (!stored) return true;
    var body = ["This browser is holding your session for “" + stored.assignment + "” (last saved " + timeStr(stored.savedAt) + "). Going ahead replaces it."];
    if (incoming && incoming.savedAt && stored.savedAt && stored.savedAt > incoming.savedAt) {
      body.push("Careful: the copy in this browser was saved more recently than the file you're opening (" + timeStr(incoming.savedAt) + ").");
    }
    body.push("If you might still need it, export it first.");
    var v = await ask("Replace the session saved in this browser?", body, [
      { label: "Export it, then continue", value: "export", kind: "btn-primary" },
      { label: "Continue without exporting", value: "go" },
      { label: "Cancel", value: null }
    ]);
    if (v === "export") exportSessionObj(stored);
    return !!v;
  }

  /* ---------- Setup form (new assignment, or editing the current one) ---------- */
  function buildSetupForm(container, mode) {
    var p = mode;
    var editing = mode === "edit";
    var v = editing ? {
      assignment: S.assignment, students: S.students.join("\n"), questions: S.questions.join("\n"),
      rubric: S.rubric.map(function (r) { return { name: r.name, max: r.max, orig: r.name }; })
    } : {
      assignment: "", students: "", questions: "Q1\nQ2\nQ3\nQ4",
      rubric: [{ name: "", max: null }, { name: "", max: null }]
    };

    var rows = h("ol", { class: "rubric-rows" });
    var addBtn = h("button", { type: "button", class: "btn-small", text: "Add a rubric column", onclick: function () { addRow({ name: "", max: null }, true); } });

    function renumber() {
      Array.prototype.forEach.call(rows.children, function (li, i) {
        var n = i + 1;
        var name = li.querySelector(".rb-name"), max = li.querySelector(".rb-max");
        var labs = li.querySelectorAll("label"), rm = li.querySelector("button");
        name.id = p + "-rb-name-" + n; labs[0].htmlFor = name.id; labs[0].textContent = "Column " + n + " name";
        max.id = p + "-rb-max-" + n; labs[1].htmlFor = max.id; labs[1].textContent = "Column " + n + " max points (optional)";
        rm.setAttribute("aria-label", "Remove column " + n);
        rm.disabled = rows.children.length === 1;
      });
    }
    function addRow(r, focus) {
      var examples = ["e.g. Content", "e.g. Style"];
      var name = h("input", { type: "text", class: "rb-name", value: r.name || "", autocomplete: "off", placeholder: examples[rows.children.length] || "Name" });
      var max = h("input", { type: "number", class: "rb-max", min: "0", step: "any", inputmode: "decimal", value: r.max == null ? "" : String(r.max), placeholder: "Max (optional)" });
      var li = h("li", { class: "rubric-row", "data-orig": r.orig || null },
        h("div", null, h("label", { class: "visually-hidden" }), name),
        h("div", null, h("label", { class: "visually-hidden" }), max),
        h("button", { type: "button", class: "btn-small", text: "Remove", onclick: function () { li.remove(); renumber(); addBtn.focus(); } }));
      rows.append(li);
      renumber();
      if (focus) name.focus();
    }
    v.rubric.forEach(function (r) { addRow(r, false); });

    // Load a rubric from a file into the rows, or download the rows as a rubric file.
    var rbStatus = h("p", { class: "field-hint", role: "status" });
    var rbFile = h("input", { type: "file", id: p + "-rubric-file", accept: ".json,.csv,application/json,text/csv", "aria-describedby": p + "-rubric-file-hint" });
    rbFile.addEventListener("change", async function () {
      var file = rbFile.files[0];
      rbStatus.textContent = "";
      rbStatus.classList.remove("error-text");
      if (!file) return;
      try {
        var list = parseRubricFile(await file.text(), file.name);
        var current = readRubricRows(rows).rubric;
        var names = function (l) { return listText(l.map(function (r) { return r.name; })); };
        if (current.length) {
          var body = ["The form has " + plural(current.length, "column") + " (" + names(current) + "). The file has " +
            plural(list.length, "column") + " (" + names(list) + ")."];
          if (editing) body.push("Nothing changes until you press Save changes. If that would remove a column that already has issues, you'll be asked first.");
          var v2 = await ask("Replace the rubric columns?", body, [
            { label: "Replace them", value: "go", kind: "btn-primary" }, { label: "Cancel", value: null }
          ]);
          if (!v2) return;
        }
        rows.replaceChildren();
        list.forEach(function (r) {
          // When editing, a column whose name matches an existing one (ignoring capitals) keeps its issues.
          var orig = null;
          if (editing) S.rubric.forEach(function (x) { if (norm(x.name) === norm(r.name)) orig = x.name; });
          addRow({ name: r.name, max: r.max, orig: orig }, false);
        });
        rbStatus.textContent = "Loaded " + plural(list.length, "rubric column") + " from " + file.name + "." +
          (editing ? " Press Save changes to use them." : "");
      } catch (e) {
        rbStatus.textContent = e.message;
        rbStatus.classList.add("error-text");
      } finally {
        rbFile.value = "";
      }
    });
    var rbDownload = h("button", { type: "button", class: "btn-small", text: "Download this rubric", onclick: function () {
      rbStatus.classList.remove("error-text");
      var res = readRubricRows(rows);
      if (res.errs.length) {
        rbStatus.textContent = "Fix the rubric first: " + res.errs.join(" ");
        rbStatus.classList.add("error-text");
        return;
      }
      var a = $(p + "-assignment").value.trim();
      download("rubric-" + slug(a || "untitled") + "-" + stamp() + ".json", JSON.stringify(rubricJson(res.rubric, a), null, 2), "application/json");
      rbStatus.textContent = "Downloaded " + plural(res.rubric.length, "rubric column") + ". Check your browser's downloads.";
    } });
    var rbField = h("div", { class: "field rubric-file" },
      h("label", { for: rbFile.id, text: "Load a rubric from a file (.json or .csv)" }),
      rbFile,
      h("p", { class: "field-hint", id: p + "-rubric-file-hint", text: "A rubric downloaded here, a session export, or a spreadsheet saved as CSV with a column name and max points on each line." }),
      rbStatus);

    // Load the student list from a file into the Students box (replacing or adding to what's there).
    var stStatus = h("p", { class: "field-hint", role: "status" });
    var stFile = h("input", { type: "file", id: p + "-students-file", accept: ".csv,.tsv,.txt,.json,text/csv,text/plain,application/json", "aria-describedby": p + "-students-file-hint" });
    stFile.addEventListener("change", async function () {
      var file = stFile.files[0];
      stStatus.textContent = "";
      stStatus.classList.remove("error-text");
      if (!file) return;
      try {
        var list = parseStudentFile(await file.text(), file.name);
        var box = $(p + "-students");
        var current = lines(box.value);
        var mode = "replace";
        if (current.length) {
          var have = current.map(norm);
          var fresh = list.filter(function (n) { return have.indexOf(norm(n)) < 0; });
          var body = ["The Students box has " + plural(current.length, "name") + ". The file has " + plural(list.length, "name") +
            (fresh.length < list.length ? ", " + plural(list.length - fresh.length, "name") + " already in the box" : "") + "."];
          if (editing) body.push("Nothing changes until you press Save changes. Removing a student who already has grading will ask you first.");
          mode = await ask("Use the students from " + file.name + "?", body, [
            { label: "Add the new names", value: "add", kind: "btn-primary" },
            { label: "Replace the list", value: "replace" },
            { label: "Cancel", value: null }
          ]);
          if (!mode) return;
          if (mode === "add") list = current.concat(fresh);
        }
        box.value = list.join("\n");
        var d = duplicates(list);
        stStatus.textContent = (mode === "add" ? "Students box now has " : "Loaded ") + plural(list.length, "student") +
          (mode === "add" ? "." : " from " + file.name + ".") + (d.length ? " Listed twice: " + listText(d) + "." : "") +
          (editing ? " Press Save changes to use them." : "");
        if (d.length) stStatus.classList.add("error-text");
      } catch (e) {
        stStatus.textContent = e.message;
        stStatus.classList.add("error-text");
      } finally {
        stFile.value = "";
      }
    });
    var stField = h("div", { class: "field" },
      h("label", { for: stFile.id, text: "Load students from a file (.csv, .txt or a session .json)" }),
      stFile,
      h("p", { class: "field-hint", id: p + "-students-file-hint", text: "A spreadsheet saved as CSV (a Name or Student column, or First name and Last name columns, or names in the first column), a text file with one name per line, or a session export." }),
      stStatus);

    var err = h("div", { class: "error-text", role: "alert" });
    var ok = h("p", { class: "field-hint", role: "status" });

    function textField(id, label, hint, control) {
      return h("div", { class: "field" },
        h("label", { for: id, text: label }), control,
        hint ? h("p", { class: "field-hint", id: id + "-hint", text: hint }) : null);
    }

    var importsBox = null;
    if (!editing) {
      pendingImports.general = pendingImports.question = null;
      importsBox = h("fieldset", { class: "imports" },
        h("legend", { text: "Bring in canned issues from earlier (optional)" }),
        h("p", { class: "field-hint", text: "General issues work for any assignment. Question-specific issues are meant for this same assignment, for example when you're regrading or a colleague is sharing the load." }),
        h("div", { class: "two-col" }, importField("general"), importField("question")));
    }
    function importField(kind) {
      var id = p + "-imp-" + kind;
      var status = h("p", { class: "field-hint", role: "status" });
      var input = h("input", { type: "file", id: id, accept: ".json,application/json" });
      input.addEventListener("change", async function () {
        pendingImports[kind] = null;
        status.textContent = "";
        status.classList.remove("error-text");
        var f = input.files[0];
        if (!f) return;
        try {
          var obj = await readJson(f);
          var k = cannedKind(obj);
          if (k !== kind) {
            throw new Error(k === "session" ? "That's a full session file. Use “Open an exported session” above instead." :
              k ? "That's a " + (k === "general" ? "general" : "question-specific") + " issues file. Use the other box." :
              "That isn't a canned-issues file from the grading assistant.");
          }
          var n = validIssues(obj, kind).length;
          pendingImports[kind] = obj;
          status.textContent = "Ready to import " + plural(n, "issue") +
            (kind === "question" && obj.assignment ? " saved for “" + obj.assignment + "”." : ".");
        } catch (e) {
          status.textContent = e.message;
          status.classList.add("error-text");
          input.value = "";
        }
      });
      return h("div", { class: "field" },
        h("label", { for: id, text: kind === "general" ? "General canned issues (.json)" : "Question-specific canned issues (.json)" }),
        input, status);
    }

    var f = h("form", { class: "setup-form", novalidate: true },
      textField(p + "-assignment", "Assignment name", null,
        h("input", { type: "text", id: p + "-assignment", value: v.assignment, autocomplete: "off" })),
      h("div", { class: "two-col" },
        h("div", null,
          textField(p + "-students", "Students", editing ?
            "One per line. Renaming someone here is fine: you'll be asked whether it's a rename or a different student." :
            "One per line. You can paste a column straight from a spreadsheet, or load a file below.",
            h("textarea", { id: p + "-students", rows: 8, "aria-describedby": p + "-students-hint", value: v.students })),
          stField),
        textField(p + "-questions", "Questions", "One per line, in the order you'll grade them.",
          h("textarea", { id: p + "-questions", rows: 8, "aria-describedby": p + "-questions-hint", value: v.questions }))),
      h("fieldset", null,
        h("legend", { text: "Rubric columns" }),
        h("p", { class: "field-hint", text: "Each issue takes points off one of these. Max points is optional: with it, the report also gives a score for that column (max minus points off, never below 0)." }),
        h("div", { class: "rubric-head", "aria-hidden": "true" }, h("span", { text: "Name" }), h("span", { text: "Max points (optional)" }), h("span")),
        rows, h("div", { class: "btn-row tight" }, addBtn, rbDownload), rbField),
      importsBox, err, ok,
      h("div", { class: "btn-row" }, h("button", { type: "submit", class: "btn btn-primary", text: editing ? "Save changes" : "Start grading" })));

    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.replaceChildren();
      ok.textContent = "";
      var res = readSetup(f, p, rows);
      if (res.errs.length) {
        err.append(res.errs.length === 1 ? res.errs[0] : h("ul", null, res.errs.map(function (x) { return h("li", { text: x }); })));
        return;
      }
      if (editing) {
        if (await applyEdit(res.vals)) ok.textContent = "Setup saved.";
      } else {
        await startNew(res.vals);
      }
    });
    container.replaceChildren(f);
    enhanceFileInputs(container);
  }

  /* ---------- Drop zones ---------- */
  // Turns each file input into a large drop target. The real input is stretched invisibly over the
  // whole zone, so clicking, keyboard use, screen readers and dropping a file all go through it natively.
  function enhanceFileInputs(root) {
    Array.prototype.forEach.call(root.querySelectorAll('input[type="file"]'), function (input) {
      if (input.parentNode.classList.contains("dropzone")) return;
      var zone = h("div", { class: "dropzone" },
        h("span", { class: "dropzone__icon", "aria-hidden": "true", text: "⇪" }),
        h("span", { class: "dropzone__text", "aria-hidden": "true" },
          h("strong", { text: "Drop a file here" }), " or click to choose one"));
      input.parentNode.insertBefore(zone, input);
      zone.insertBefore(input, zone.firstChild);
      var depth = 0;
      zone.addEventListener("dragenter", function () { depth++; zone.classList.add("is-over"); });
      zone.addEventListener("dragleave", function () { if (--depth <= 0) { depth = 0; zone.classList.remove("is-over"); } });
      zone.addEventListener("drop", function () { depth = 0; zone.classList.remove("is-over"); });
    });
  }

  function readRubricRows(rows) {
    var errs = [], rubric = [];
    Array.prototype.forEach.call(rows.children, function (li, i) {
      var name = li.querySelector(".rb-name").value.trim();
      var maxRaw = li.querySelector(".rb-max").value.trim();
      if (!name && !maxRaw) return;
      if (!name) { errs.push("Rubric column " + (i + 1) + " needs a name."); return; }
      var max = null;
      if (maxRaw) {
        max = Number(maxRaw);
        if (!isNum(max) || max < 0) { errs.push("The max points for “" + name + "” should be a number of 0 or more (or left blank)."); return; }
      }
      rubric.push({ name: name, max: max, orig: li.dataset.orig || null });
    });
    if (!rubric.length) errs.push("Add at least one rubric column.");
    var d = duplicates(rubric.map(function (r) { return r.name; }));
    if (d.length) errs.push("These rubric columns are listed twice: " + listText(d) + ".");
    return { errs: errs, rubric: rubric };
  }

  /* ---------- Rubric files ---------- */
  // Small CSV reader: commas (or another delimiter, e.g. tab), quoted fields with "" escapes, CRLF or LF.
  function parseCsv(text, delim) {
    delim = delim || ",";
    var rows = [], row = [], cell = "", q = false;
    text = String(text).replace(/^﻿/, "");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map(function (r) { return r.map(function (c) { return c.trim(); }); })
      .filter(function (r) { return r.some(Boolean); });
  }

  // Reads a rubric from a rubric .json, a session export, or a CSV of "name,max" rows.
  function parseRubricFile(text, filename) {
    var list;
    var trimmed = String(text).replace(/^﻿/, "").trim();
    if (/\.json$/i.test(filename) || trimmed.charAt(0) === "{") {
      var o;
      try { o = JSON.parse(trimmed); } catch (e) { throw new Error("That file isn't valid JSON, so it can't be loaded."); }
      if (!o || (o.format !== FMT.rubric && o.format !== FMT.session)) {
        throw new Error(o && (o.format === FMT.general || o.format === FMT.question) ?
          "That's a canned-issues file, not a rubric." : "That isn't a rubric file from the grading assistant.");
      }
      if (!Array.isArray(o.rubric)) throw new Error("This file has no rubric columns in it.");
      list = o.rubric.map(function (r, i) {
        var name = r && typeof r.name === "string" ? r.name.trim() : "";
        if (!name) throw new Error("Rubric column " + (i + 1) + " in this file has no name.");
        if (r.max != null && (!isNum(r.max) || r.max < 0)) throw new Error("The max points for “" + name + "” in this file isn't a number of 0 or more.");
        return { name: name, max: r.max == null ? null : r.max };
      });
    } else {
      var rows = parseCsv(trimmed);
      var isNumCell = function (c) { return c === "" || (isNum(Number(c)) && Number(c) >= 0); };
      if (rows.length > 1 && rows[0].length > 1 && !isNumCell(rows[0][1])) rows = rows.slice(1); // header row, e.g. "Name,Max"
      list = rows.map(function (r) {
        var name = r[0] || "";
        if (!name) throw new Error("A row in this file has a max but no column name.");
        var maxRaw = r[1] || "";
        if (!isNumCell(maxRaw)) throw new Error("The max points for “" + name + "” (" + maxRaw + ") isn't a number of 0 or more.");
        return { name: name, max: maxRaw === "" ? null : Number(maxRaw) };
      });
    }
    if (!list.length) throw new Error("This file has no rubric columns in it.");
    var d = duplicates(list.map(function (r) { return r.name; }));
    if (d.length) throw new Error("This file lists these rubric columns twice: " + listText(d) + ".");
    return list;
  }

  /* ---------- Student list files ---------- */
  // Reads student names from a session export (.json), a plain list (.txt, one per line),
  // or a spreadsheet saved as CSV/TSV. With a header row, a "Name"/"Student" column wins,
  // then "First name" + "Last name"; otherwise the first column is used.
  function parseStudentFile(text, filename) {
    var trimmed = String(text).replace(/^﻿/, "").trim();
    var names;
    if (/\.json$/i.test(filename) || trimmed.charAt(0) === "{") {
      var o;
      try { o = JSON.parse(trimmed); } catch (e) { throw new Error("That file isn't valid JSON, so it can't be loaded."); }
      if (!o || o.format !== FMT.session || !Array.isArray(o.students)) {
        throw new Error("That JSON file isn't a session export, so it has no student list. Use a .txt, .csv or session file.");
      }
      names = o.students.filter(function (x) { return typeof x === "string"; });
    } else if (/\.txt$/i.test(filename) && trimmed.indexOf("\t") < 0) {
      names = lines(trimmed);
    } else {
      var tsv = /\.tsv$/i.test(filename) || (trimmed.indexOf("\t") >= 0 && trimmed.indexOf(",") < 0);
      var rows = parseCsv(trimmed, tsv ? "\t" : ",");
      var col = 0, first = -1, last = -1;
      var head = (rows[0] || []).map(norm);
      var nameRe = /^(student|students|name|names|full name|student name|student full name|display name)$/;
      var isHeader = head.some(function (c) {
        return nameRe.test(c) || /^(first|given|last|family|sur)\s*name$|^surname$/.test(c);
      });
      if (isHeader) {
        col = -1;
        head.forEach(function (c, i) {
          if (col < 0 && nameRe.test(c)) col = i;
          if (first < 0 && /^(first|given)\s*name$/.test(c)) first = i;
          if (last < 0 && (/^(last|family|sur)\s*name$/.test(c) || c === "surname")) last = i;
        });
        rows = rows.slice(1);
        if (col < 0 && first < 0 && last < 0) col = 0;
      }
      names = rows.map(function (r) {
        if (col >= 0) return r[col] || "";
        return [first >= 0 ? r[first] : "", last >= 0 ? r[last] : ""].filter(Boolean).join(" ");
      });
    }
    names = names.map(function (n) { return String(n).replace(/\s+/g, " ").trim(); })
      .filter(function (n) { return n && !/^points possible$/i.test(n); }); // Canvas gradebook exports have this row
    if (!names.length) throw new Error("No student names found in this file.");
    return names;
  }

  function rubricJson(rubric, assignment) {
    return {
      format: FMT.rubric, version: 1, from: assignment || null, exportedAt: new Date().toISOString(),
      rubric: rubric.map(function (r) { return { name: r.name, max: r.max }; })
    };
  }

  function readSetup(f, p, rows) {
    var errs = [];
    var assignment = $(p + "-assignment").value.trim();
    if (!assignment) errs.push("Give the assignment a name.");
    var students = lines($(p + "-students").value);
    if (!students.length) errs.push("Add at least one student.");
    var d = duplicates(students);
    if (d.length) errs.push("These students are listed twice: " + listText(d) + ". Add something to tell them apart, like a last initial.");
    var questions = lines($(p + "-questions").value);
    if (!questions.length) errs.push("Add at least one question.");
    d = duplicates(questions);
    if (d.length) errs.push("These questions are listed twice: " + listText(d) + ".");
    var rb = readRubricRows(rows);
    errs = errs.concat(rb.errs);
    var rubric = rb.rubric;
    return { errs: errs, vals: { assignment: assignment, students: students, questions: questions, rubric: rubric } };
  }

  async function startNew(vals) {
    if (!(await replaceStoredOk(null))) return;
    S = newState(vals);
    var msgs = [];
    if (pendingImports.general) msgs.push(await importCanned(pendingImports.general, "general"));
    if (pendingImports.question) msgs.push(await importCanned(pendingImports.question, "question"));
    pendingImports.general = pendingImports.question = null;
    persist();
    updateChrome();
    show("grade");
    notice(msgs);
  }

  /* ---------- Setup screen (editing) ---------- */
  function renderSetup() { buildSetupForm($("edit-setup"), "edit"); }

  async function askRenames(kind, gone, added) {
    if (!gone.length || gone.length !== added.length || gone.length > 8) return null;
    var pairs = gone.map(function (g, i) { return g + " → " + added[i]; });
    var v = await ask("Did you rename " + (gone.length === 1 ? "a " + kind : kind + "s") + "?", [
      "These names disappeared and new ones appeared: " + pairs.join("; ") + ".",
      "If they're renames, their grading moves to the new name. If not, the old " + (gone.length === 1 ? kind : kind + "s") + " will be removed."
    ], [
      { label: "Yes, " + (gone.length === 1 ? "it's a rename" : "they're renames"), value: "rename", kind: "btn-primary" },
      { label: "No, " + (gone.length === 1 ? "it's a different " + kind : "they're different " + kind + "s"), value: "different" },
      { label: "Cancel", value: null }
    ]);
    if (v === null) return false;
    if (v !== "rename") return null;
    var map = {};
    gone.forEach(function (g, i) { map[g] = added[i]; });
    return map;
  }

  async function applyEdit(vals) {
    var goneS = S.students.filter(function (s) { return vals.students.indexOf(s) < 0; });
    var addS = vals.students.filter(function (s) { return S.students.indexOf(s) < 0; });
    var goneQ = S.questions.filter(function (q) { return vals.questions.indexOf(q) < 0; });
    var addQ = vals.questions.filter(function (q) { return S.questions.indexOf(q) < 0; });

    var renS = await askRenames("student", goneS, addS);
    if (renS === false) return false;
    var renQ = await askRenames("question", goneQ, addQ);
    if (renQ === false) return false;
    var renR = {};
    vals.rubric.forEach(function (r) { if (r.orig && r.orig !== r.name) renR[r.orig] = r.name; });

    var keptRubricOrig = vals.rubric.map(function (r) { return r.orig || r.name; });
    var goneR = S.rubric.map(function (r) { return r.name; }).filter(function (n) { return keptRubricOrig.indexOf(n) < 0; });
    if (renS) goneS = []; if (renQ) goneQ = [];

    var hasData = function (r) { return r.status === "graded" || r.issues.length; };
    var hitS = goneS.filter(function (s) { return S.records.some(function (r) { return r.student === s && hasData(r); }); });
    var hitQ = goneQ.filter(function (q) {
      return S.records.some(function (r) { return r.question === q && hasData(r); }) ||
        S.canned.some(function (c) { return c.question === q && c.scope !== "general"; });
    });
    var hitR = goneR.filter(function (n) {
      return S.canned.some(function (c) { return c.rubric === n; }) ||
        S.records.some(function (r) { return r.issues.some(function (i) { return i.rubric === n; }); });
    });
    if (hitS.length || hitQ.length || hitR.length) {
      var body = ["Removing these also removes the grading attached to them:"];
      if (hitS.length) body.push("Students: " + listText(hitS) + ".");
      if (hitQ.length) body.push("Questions: " + listText(hitQ) + " (their grading and question-specific canned issues).");
      if (hitR.length) body.push("Rubric columns: " + listText(hitR) + " (every issue in them, canned or not).");
      var v = await ask("Remove grading too?", body, [
        { label: "Remove them", value: "go", kind: "btn-primary" }, { label: "Cancel", value: null }
      ]);
      if (!v) return false;
    }

    // Renames first, then removals.
    S.records.forEach(function (r) {
      if (renS && renS[r.student]) r.student = renS[r.student];
      if (renQ && renQ[r.question]) r.question = renQ[r.question];
      r.issues.forEach(function (i) { if (renR[i.rubric]) i.rubric = renR[i.rubric]; });
    });
    S.canned.forEach(function (c) {
      if (renQ && c.question && renQ[c.question]) c.question = renQ[c.question];
      if (renR[c.rubric]) c.rubric = renR[c.rubric];
    });
    S.reviewed = S.reviewed.map(function (q) { return renQ && renQ[q] ? renQ[q] : q; });
    if (renS && renS[S.position.student]) S.position.student = renS[S.position.student];
    if (renQ && renQ[S.position.question]) S.position.question = renQ[S.position.question];

    S.assignment = vals.assignment;
    S.students = vals.students;
    S.questions = vals.questions;
    S.rubric = vals.rubric.map(function (r) { return { name: r.name, max: r.max }; });
    var rnames = S.rubric.map(function (r) { return r.name; });
    S.records = S.records.filter(function (r) { return S.students.indexOf(r.student) >= 0 && S.questions.indexOf(r.question) >= 0; });
    S.records.forEach(function (r) { r.issues = r.issues.filter(function (i) { return rnames.indexOf(i.rubric) >= 0; }); });
    S.canned = S.canned.filter(function (c) {
      return rnames.indexOf(c.rubric) >= 0 && (c.scope === "general" || S.questions.indexOf(c.question) >= 0);
    });
    var ids = {};
    S.canned.forEach(function (c) { ids[c.id] = true; });
    S.records.forEach(function (r) { r.issues.forEach(function (i) { if (i.cannedId && !ids[i.cannedId]) i.cannedId = null; }); });
    S.reviewed = S.reviewed.filter(function (q) { return S.questions.indexOf(q) >= 0; });
    fixPosition();
    clearForm();
    persist();
    updateChrome();
    renderSetup();
    var t = $("edit-setup").querySelector(".field-hint[role='status']");
    if (t) t.textContent = "Setup saved.";
    announce("Setup saved.");
    return false; // the form was rebuilt, so the caller doesn't need to show anything
  }

  /* ---------- Grade ---------- */
  function renderGrade() {
    fixPosition();
    renderGradeMeta();
    var cur = $("issue-rubric").value;
    fillSelect($("issue-rubric"), S.rubric.map(function (r) { return r.name; }), cur || S.rubric[0].name);
    renderPickers();
    renderIssueList();
    updateLinkStatus();
    $("auto-copy").checked = !!S.prefs.autoCopy;
  }

  function renderGradeMeta() {
    var q = S.position.question, st = S.position.student;
    var qi = S.questions.indexOf(q), si = S.students.indexOf(st);
    $("grade-title").textContent = q + ": " + st;
    var graded = S.students.filter(function (s) { return statusOf(q, s) === "graded"; }).length;
    $("grade-meta").textContent = "Student " + (si + 1) + " of " + S.students.length + ". " + graded + " of " +
      S.students.length + " answers to " + q + " marked graded" + (statusOf(q, st) === "graded" ? ", including this one." : ".");
    $("prev-answer").disabled = si === 0 && qi === 0;
    $("save-next").textContent = si === S.students.length - 1 ? "Mark graded, then finish " + q : "Mark graded, next student";
    fillSelect($("jump-question"), S.questions, q);
    fillSelect($("jump-student"), S.students.map(function (s) {
      var stt = statusOf(q, s);
      return { value: s, label: s + (stt === "graded" ? " (graded)" : stt === "started" ? " (started)" : "") };
    }), st);
    $("finish-question").textContent = "Review " + q + "’s canned issues";
  }

  function renderPickers() {
    var q = S.position.question, wrap = $("pickers");
    var counts = useCounts();
    var vis = visibleCanned(q);
    wrap.replaceChildren();
    S.rubric.forEach(function (col, i) {
      var list = vis.filter(function (c) { return c.rubric === col.name; }).sort(function (a, b) {
        return (counts[b.id] || 0) - (counts[a.id] || 0) || a.text.localeCompare(b.text);
      });
      var id = "pick-" + i;
      var sel = h("select", { id: id, disabled: !list.length },
        h("option", { value: "", text: list.length ? "Pick a canned issue…" : "No canned issues yet" }),
        list.map(function (c) {
          return h("option", { value: c.id, text: minus(c.points) + ": " + trunc(c.text, 90) + (c.scope === "question" ? " (" + q + " only)" : "") });
        }));
      sel.addEventListener("change", function () { pickCanned(sel); });
      wrap.append(h("div", { class: "field" }, h("label", { for: id, text: col.name + " issues (" + list.length + ")" }), sel));
    });
  }

  function pickCanned(sel) {
    Array.prototype.forEach.call($("pickers").querySelectorAll("select"), function (s) { if (s !== sel) s.value = ""; });
    var c = cannedById(sel.value);
    if (!c) return;
    $("issue-text").value = c.text;
    $("issue-rubric").value = c.rubric;
    $("issue-points").value = fmt(c.points);
    $("issue-error").textContent = "";
    form.cannedId = c.id;
    updateLinkStatus();
  }

  function editingIssue() {
    if (!form.editingId) return null;
    var r = rec(S.position.question, S.position.student);
    if (!r) return null;
    for (var i = 0; i < r.issues.length; i++) if (r.issues[i].id === form.editingId) return r.issues[i];
    return null;
  }

  // What the issue form would be linked to if added right now.
  function formTarget() {
    var text = $("issue-text").value, rubric = $("issue-rubric").value;
    if (!text.trim()) return { how: "empty", c: null };
    if (form.cannedId) {
      var c = cannedById(form.cannedId);
      if (c && c.rubric === rubric && norm(c.text) === norm(text)) return { how: "picked", c: c };
    }
    if ($("issue-specific").checked) return { how: "specific", c: null };
    var m = visibleCanned(S.position.question).filter(function (x) { return x.rubric === rubric && norm(x.text) === norm(text); })[0];
    if (m) return { how: "match", c: m };
    return { how: form.cannedId ? "changed" : "new", c: null };
  }

  function updateLinkStatus() {
    if (!S) return;
    var t = formTarget(), q = S.position.question, spec = $("issue-specific");
    spec.disabled = t.how === "picked";
    if (t.how === "picked") spec.checked = false;
    var raw = $("issue-points").value.trim();
    var pts = raw === "" ? NaN : round2(Number(raw));
    var msg = "";
    if (t.c) {
      msg = t.how === "picked" ? "Canned issue." : "Same wording as a canned issue, so it'll be linked to that one.";
      if (isNum(pts) && pts !== round2(t.c.points)) {
        var others = usesOf(t.c.id, editingIssue());
        msg += others ?
          " It's saved at " + minus(t.c.points) + " and used in " + plural(others, "other answer") + ", so you'll be asked what to update." :
          " Its saved deduction will change from " + minus(t.c.points) + " to " + minus(pts) + ".";
      }
    } else if (t.how === "specific") {
      msg = "Student-specific: it won't be saved to your canned issues.";
    } else if (t.how === "changed") {
      msg = "You've changed the wording, so this counts as a new issue and will be saved to the canned issues for " + q + ".";
    } else if (t.how === "new") {
      msg = "New issue: it'll be saved to the canned issues for " + q + ".";
    }
    $("link-status").textContent = msg;
  }

  function askPoints(c, pts, others, inForm) {
    var btns = [
      { label: "Change all " + plural(others + (inForm ? 1 : 0), "answer") + " to " + minus(pts), value: "all", kind: "btn-primary" },
      { label: "Use " + minus(pts) + " from now on, keep earlier answers as they are", value: "canned" }
    ];
    if (inForm) btns.push({ label: "Just this answer (canned issue stays at " + minus(c.points) + ")", value: "this" });
    btns.push({ label: "Cancel", value: null });
    return ask("Change the points for a canned issue?", [
      "“" + trunc(c.text, 140) + "” (" + c.rubric + ") is saved at " + minus(c.points) + ". You've set it to " + minus(pts) + ".",
      "It's already used in " + plural(others, inForm ? "other answer" : "answer") + "."
    ], btns);
  }

  async function submitIssue() {
    var err = $("issue-error");
    err.textContent = "";
    var text = $("issue-text").value.trim(), rubric = $("issue-rubric").value, raw = $("issue-points").value.trim();
    var pts = raw === "" ? NaN : round2(Number(raw));
    if (!text) { err.textContent = "Write the issue first, or pick one from a list above."; $("issue-text").focus(); return false; }
    if (!isNum(pts) || pts < 0) {
      err.textContent = "How many points does this take off? Use 0 for a comment with no deduction.";
      $("issue-points").focus();
      return false;
    }
    var q = S.position.question, st = S.position.student;
    var editing = editingIssue();
    var t = formTarget();
    var c = t.c, created = false, changedCanned = "";
    if (c && pts !== round2(c.points)) {
      var others = usesOf(c.id, editing);
      var choice = others ? await askPoints(c, pts, others, true) : "canned";
      if (!choice) return false;
      if (choice === "all") eachUse(c.id, function (i) { i.points = pts; });
      if (choice !== "this") {
        c.points = pts;
        changedCanned = choice === "all" ? " Updated everywhere it's used." : " Canned issue now " + minus(pts) + ".";
      }
    }
    if (!c && t.how !== "specific") {
      c = { id: uid("c"), text: text, rubric: rubric, points: pts, scope: "unreviewed", question: q };
      S.canned.push(c);
      created = true;
    }
    var r = rec(q, st, true);
    var issue = {
      id: editing ? editing.id : uid("i"), text: text, rubric: rubric, points: pts,
      cannedId: c ? c.id : null, studentSpecific: !c
    };
    if (editing) r.issues[r.issues.indexOf(editing)] = issue;
    else r.issues.push(issue);
    prune();
    persist();
    clearForm();
    renderPickers();
    renderIssueList();
    renderGradeMeta();
    var msg = (editing ? "Issue updated" : "Issue added") + ": " + minus(pts) + " " + rubric + "." +
      (created ? " Saved to canned issues." : "") + changedCanned;
    if (S.prefs.autoCopy) msg += (await copyText(text)) ? " Copied to the clipboard." : " Couldn't copy it to the clipboard.";
    $("link-status").textContent = msg;
    announce(msg);
    return true;
  }

  function clearForm() {
    $("issue-text").value = "";
    $("issue-points").value = "";
    $("issue-specific").checked = false;
    $("issue-error").textContent = "";
    form.cannedId = null;
    var wasEditing = !!form.editingId;
    form.editingId = null;
    $("issue-submit").textContent = "Add issue";
    $("issue-submit").classList.remove("btn-editing");
    Array.prototype.forEach.call($("pickers").querySelectorAll("select"), function (s) { s.value = ""; });
    if (S && screen === "grade") {
      updateLinkStatus();
      if (wasEditing) renderIssueList();
    }
  }

  function renderIssueList() {
    var q = S.position.question, st = S.position.student;
    var r = rec(q, st), list = $("issue-list");
    var issues = r ? r.issues : [];
    list.replaceChildren();
    if (!issues.length) list.append(h("li", { class: "empty", text: "No issues yet. If the answer is spot on, just mark it graded." }));
    issues.forEach(function (it, i) {
      var n = i + 1;
      var kind = it.cannedId ? "Canned" : it.studentSpecific ? "Student-specific" : "Not in canned list";
      list.append(h("li", { class: "issue" + (form.editingId === it.id ? " editing" : "") },
        h("div", { class: "issue__head" },
          h("span", { class: "issue__pts", text: minus(it.points) }),
          h("span", { class: "tag", text: it.rubric }),
          h("span", { class: "tag tag--muted", text: kind })),
        h("p", { class: "issue__text", text: it.text }),
        h("div", { class: "issue__actions" },
          h("button", { type: "button", class: "btn-small", text: "Copy", "aria-label": "Copy issue " + n, onclick: async function () {
            announce((await copyText(it.text)) ? "Issue " + n + " copied to the clipboard." : "Couldn't copy to the clipboard.");
          } }),
          h("button", { type: "button", class: "btn-small", text: "Edit", "aria-label": "Edit issue " + n, onclick: function () { startEdit(it); } }),
          h("button", { type: "button", class: "btn-small", text: "Remove", "aria-label": "Remove issue " + n, onclick: function () { removeIssue(it); } }))));
    });
    var totals = S.rubric.map(function (col) {
      var sum = issues.filter(function (i) { return i.rubric === col.name; }).reduce(function (a, i) { return a + i.points; }, 0);
      return sum ? col.name + " " + minus(sum) : null;
    }).filter(Boolean);
    var all = issues.reduce(function (a, i) { return a + i.points; }, 0);
    $("issue-totals").textContent = issues.length ? "Points off: " + (totals.length ? totals.join(", ") + ". " : "") + "Total " + minus(all) + "." : "";
  }

  function startEdit(it) {
    $("issue-text").value = it.text;
    $("issue-rubric").value = it.rubric;
    $("issue-points").value = fmt(it.points);
    $("issue-specific").checked = it.studentSpecific;
    Array.prototype.forEach.call($("pickers").querySelectorAll("select"), function (s) { s.value = ""; });
    form.cannedId = it.cannedId;
    form.editingId = it.id;
    $("issue-submit").textContent = "Save changes";
    $("issue-submit").classList.add("btn-editing");
    renderIssueList();
    updateLinkStatus();
    $("issue-text").focus();
  }

  function removeIssue(it) {
    var r = rec(S.position.question, S.position.student);
    if (!r) return;
    r.issues = r.issues.filter(function (i) { return i !== it; });
    if (form.editingId === it.id) clearForm();
    prune();
    persist();
    renderPickers();
    renderIssueList();
    renderGradeMeta();
    updateLinkStatus();
    $("list-title").focus();
    announce("Issue removed.");
  }

  async function guardForm() {
    if (screen !== "grade" || !S || !$("issue-text").value.trim()) return true;
    var v = await ask("You have an issue that hasn't been added", [
      "“" + trunc($("issue-text").value, 140) + "” is still in the form."
    ], [
      { label: form.editingId ? "Save it, then continue" : "Add it, then continue", value: "add", kind: "btn-primary" },
      { label: "Discard it", value: "discard" },
      { label: "Stay here", value: null }
    ]);
    if (v === "add") return await submitIssue();
    if (v === "discard") { clearForm(); return true; }
    return false;
  }

  function goTo(q, st) {
    S.position = { question: q, student: st };
    persist(false);
    clearForm();
    if (screen !== "grade") show("grade");
    else { renderGrade(); $("grade-title").focus(); }
  }

  async function saveNext() {
    if (!(await guardForm())) return;
    var q = S.position.question, st = S.position.student;
    rec(q, st, true).status = "graded";
    persist();
    var si = S.students.indexOf(st);
    if (si < S.students.length - 1) {
      goTo(q, S.students[si + 1]);
      announce(st + " marked graded.");
      return;
    }
    var left = S.students.filter(function (s) { return statusOf(q, s) !== "graded"; });
    if (left.length) {
      var v = await ask(q + " isn't finished yet", [
        plural(left.length, "answer") + " to " + q + " " + (left.length === 1 ? "isn't" : "aren't") + " marked graded yet: " + listText(left) + "."
      ], [
        { label: "Go to the first one", value: "first", kind: "btn-primary" },
        { label: "Review " + q + "’s issues anyway", value: "review" },
        { label: "Stay here", value: null }
      ]);
      if (v === "first") goTo(q, left[0]);
      else if (v === "review") openReview(q);
      else renderGradeMeta();
      return;
    }
    openReview(q);
  }

  async function prevAnswer() {
    if (!(await guardForm())) return;
    var qi = S.questions.indexOf(S.position.question), si = S.students.indexOf(S.position.student);
    if (si > 0) si--;
    else if (qi > 0) { qi--; si = S.students.length - 1; }
    else return;
    goTo(S.questions[qi], S.students[si]);
  }

  /* ---------- Review a question's canned issues ---------- */
  function openReview(q) {
    reviewQ = q;
    show("review");
  }

  function renderReview() {
    var q = reviewQ;
    if (S.questions.indexOf(q) < 0) q = reviewQ = S.position.question;
    var qi = S.questions.indexOf(q), next = S.questions[qi + 1];
    var counts = useCounts();
    $("review-title").textContent = "Finish " + q + ": which issues belong only to " + q + "?";
    var body = $("review-body");
    body.replaceChildren();
    var items = S.canned.filter(function (c) { return c.question === q; }).sort(function (a, b) {
      return (a.scope === "unreviewed" ? 0 : 1) - (b.scope === "unreviewed" ? 0 : 1) ||
        rubricIdx(a.rubric) - rubricIdx(b.rubric) || (counts[b.id] || 0) - (counts[a.id] || 0);
    });
    var left = S.students.filter(function (s) { return statusOf(q, s) !== "graded"; });
    if (left.length) {
      body.append(h("p", { class: "warn", text: "Heads up: " + plural(left.length, "answer") + " to " + q + " " +
        (left.length === 1 ? "isn't" : "aren't") + " marked graded yet (" + listText(left) + "). You can still sort the issues now." }));
    }
    var boxes = [];
    if (!items.length) {
      body.append(h("p", { text: "No canned issues came from " + q + ", so there's nothing to sort." }));
    } else {
      body.append(h("p", { text: "Tick the issues that only make sense for " + q + ". Anything left unticked becomes a general issue and appears in the lists for every question from now on." }));
      var tbody = h("tbody");
      items.forEach(function (c, i) {
        var id = "rv-" + i;
        var box = h("input", { type: "checkbox", id: id, checked: c.scope === "question" });
        box.dataset.id = c.id;
        boxes.push(box);
        tbody.append(h("tr", null,
          h("td", { class: "check-cell" }, h("label", { for: id, class: "visually-hidden", text: "Only for " + q + ": " + trunc(c.text, 80) }), box),
          h("td", { class: "issue-cell" }, c.scope === "unreviewed" ? [h("span", { class: "tag tag--new", text: "New" }), " "] : null, c.text),
          h("td", { text: c.rubric }),
          h("td", { class: "num", text: minus(c.points) }),
          h("td", { class: "num", text: String(counts[c.id] || 0) })));
      });
      body.append(h("div", { class: "table-scroll", role: "region", "aria-label": "Canned issues from " + q, tabindex: "0" },
        h("table", { class: "data" },
          h("thead", null, h("tr", null,
            h("th", { scope: "col", text: "Only for " + q }), h("th", { scope: "col", text: "Issue" }),
            h("th", { scope: "col", text: "Rubric column" }), h("th", { scope: "col", class: "num", text: "Points off" }),
            h("th", { scope: "col", class: "num", text: "Times used" }))),
          tbody)));
    }
    function save() {
      boxes.forEach(function (b) {
        var c = cannedById(b.dataset.id);
        if (c) c.scope = b.checked ? "question" : "general";
      });
      if (S.reviewed.indexOf(q) < 0) S.reviewed.push(q);
      persist();
      var nq = boxes.filter(function (b) { return b.checked; }).length;
      return items.length ? plural(boxes.length - nq, "general issue") + " and " + nq + " only for " + q + "." : "";
    }
    body.append(h("div", { class: "btn-row" },
      h("button", { type: "button", class: "btn btn-primary", text: next ? "Save and start " + next : "Save and see the report", onclick: function () {
        var msg = save();
        if (next) goTo(next, firstUngraded(next) || S.students[0]);
        else show("report");
        if (msg) announce("Saved: " + msg);
      } }),
      h("button", { type: "button", class: "btn btn-outline", text: "Save and keep grading " + q, onclick: function () {
        var msg = save();
        goTo(q, S.position.question === q ? S.position.student : (firstUngraded(q) || S.students[0]));
        if (msg) announce("Saved: " + msg);
      } })));
  }

  /* ---------- Progress ---------- */
  function renderProgress() {
    var body = $("progress-body");
    body.replaceChildren();
    var ul = h("ul", { class: "q-summary" });
    S.questions.forEach(function (q) {
      var graded = S.students.filter(function (s) { return statusOf(q, s) === "graded"; }).length;
      var fresh = S.canned.filter(function (c) { return c.question === q && c.scope === "unreviewed"; }).length;
      ul.append(h("li", null,
        h("span", { class: "q-name", text: q }),
        h("span", { text: graded + " of " + S.students.length + " graded. " +
          (fresh ? plural(fresh, "new canned issue") + " to sort." : S.reviewed.indexOf(q) >= 0 ? "Canned issues sorted." : "No canned issues to sort.") }),
        h("span", { class: "btn-row tight" },
          h("button", { type: "button", class: "btn-small", text: "Grade " + q, onclick: function () { goTo(q, firstUngraded(q) || S.students[0]); } }),
          h("button", { type: "button", class: "btn-small", text: "Review " + q + "’s issues", onclick: function () { openReview(q); } }))));
    });
    body.append(ul);
    body.append(h("p", { class: "meta", text: "Click any answer to open it." }));
    var tbody = h("tbody");
    S.students.forEach(function (s) {
      tbody.append(h("tr", null, h("th", { scope: "row", text: s }), S.questions.map(function (q) {
        var st = statusOf(q, s), off = offFor(q, s);
        var label = st === "graded" ? "Graded, " + (off ? minus(off) : "no deductions") : st === "started" ? "Started, " + minus(off) : "Not started";
        return h("td", null, h("button", { type: "button", class: "cell-btn st-" + st, onclick: function () { goTo(q, s); } },
          h("span", { class: "visually-hidden", text: s + ", " + q + ": " }), label));
      })));
    });
    body.append(h("div", { class: "table-scroll", role: "region", "aria-label": "Answers by student and question", tabindex: "0" },
      h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", { scope: "col", text: "Student" }), S.questions.map(function (q) { return h("th", { scope: "col", text: q }); }))),
        tbody)));
  }

  /* ---------- Canned issue library ---------- */
  function renderLibrary() {
    var sel = $("lib-filter");
    var opts = [{ value: "all", label: "All canned issues" }, { value: "general", label: "General (every question)" },
      { value: "new", label: "New, not sorted yet" }].concat(S.questions.map(function (q) { return { value: "q:" + q, label: "Only for " + q }; }));
    fillSelect(sel, opts, libFilter);
    libFilter = sel.value;
    var counts = useCounts();
    var list = S.canned.filter(function (c) {
      if (libFilter === "general") return c.scope === "general";
      if (libFilter === "new") return c.scope === "unreviewed";
      if (libFilter.indexOf("q:") === 0) return c.scope !== "general" && c.question === libFilter.slice(2);
      return true;
    }).sort(function (a, b) {
      return rubricIdx(a.rubric) - rubricIdx(b.rubric) || (counts[b.id] || 0) - (counts[a.id] || 0) || a.text.localeCompare(b.text);
    });
    $("lib-count").textContent = "Showing " + list.length + " of " + plural(S.canned.length, "canned issue") + ".";
    var body = $("lib-body");
    body.replaceChildren();
    if (!list.length) {
      body.append(h("p", { class: "meta", text: S.canned.length ? "Nothing matches this filter." : "No canned issues yet. They appear here as you grade." }));
      return;
    }
    var tbody = h("tbody");
    list.forEach(function (c, i) {
      var short = trunc(c.text, 60);
      var pts = h("input", { type: "number", class: "cell-input", min: "0", step: "any", inputmode: "decimal", value: fmt(c.points), id: "lib-pts-" + i });
      pts.addEventListener("change", async function () {
        var v = pts.value.trim() === "" ? NaN : round2(Number(pts.value));
        if (!isNum(v) || v < 0) { pts.value = fmt(c.points); announce("Points need to be a number of 0 or more."); return; }
        if (v === round2(c.points)) return;
        var uses = usesOf(c.id, null);
        var choice = uses ? await askPoints(c, v, uses, false) : "canned";
        if (!choice) { pts.value = fmt(c.points); return; }
        if (choice === "all") eachUse(c.id, function (u) { u.points = v; });
        c.points = v;
        persist();
        announce("Saved: " + minus(v) + (choice === "all" ? ", updated in every answer that uses it." : ", from now on."));
      });
      var where = h("select", { class: "cell-input", id: "lib-where-" + i },
        h("option", { value: "all", text: "Every question" }),
        S.questions.map(function (q) { return h("option", { value: "q:" + q, text: "Only " + q }); }));
      where.value = c.scope === "general" ? "all" : "q:" + c.question;
      where.addEventListener("change", function () {
        if (where.value === "all") c.scope = "general";
        else { c.scope = "question"; c.question = where.value.slice(2); }
        persist();
        announce("Saved.");
      });
      tbody.append(h("tr", null,
        h("td", { class: "issue-cell" }, c.scope === "unreviewed" ? [h("span", { class: "tag tag--new", text: "New" }), " "] : null, c.text),
        h("td", { text: c.rubric }),
        h("td", null, h("label", { for: pts.id, class: "visually-hidden", text: "Points off for: " + short }), pts),
        h("td", null, h("label", { for: where.id, class: "visually-hidden", text: "Shows up in, for: " + short }), where),
        h("td", { class: "num", text: String(counts[c.id] || 0) }),
        h("td", null, h("button", { type: "button", class: "btn-small", text: "Delete", "aria-label": "Delete: " + short, onclick: function () { deleteCanned(c); } }))));
    });
    body.append(h("div", { class: "table-scroll", role: "region", "aria-label": "Table of canned issues", tabindex: "0" },
      h("table", { class: "data" },
        h("thead", null, h("tr", null,
          h("th", { scope: "col", text: "Issue" }), h("th", { scope: "col", text: "Rubric column" }),
          h("th", { scope: "col", text: "Points off" }), h("th", { scope: "col", text: "Shows up in" }),
          h("th", { scope: "col", class: "num", text: "Times used" }), h("th", { scope: "col", html: null }, h("span", { class: "visually-hidden", text: "Actions" })))),
        tbody)));
  }

  async function deleteCanned(c) {
    var uses = usesOf(c.id, null);
    var v = await ask("Delete this canned issue?", [
      "“" + trunc(c.text, 140) + "” will no longer appear in your lists.",
      uses ? "The " + plural(uses, "answer") + " that already use it keep the comment and the deduction." : "It isn't used in any answer yet."
    ], [{ label: "Delete it", value: "go", kind: "btn-primary" }, { label: "Cancel", value: null }]);
    if (!v) return;
    eachUse(c.id, function (i) { i.cannedId = null; });
    S.canned = S.canned.filter(function (x) { return x !== c; });
    persist();
    renderLibrary();
    $("library-title").focus();
    announce("Canned issue deleted.");
  }

  /* ---------- Importing canned issues ---------- */
  function cannedKind(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (obj.format === FMT.general) return "general";
    if (obj.format === FMT.question) return "question";
    if (obj.format === FMT.session) return "session";
    return null;
  }
  function validIssues(obj, kind) {
    if (!Array.isArray(obj.issues)) throw new Error("This file has no list of issues in it.");
    return obj.issues.filter(function (i) {
      return i && typeof i.text === "string" && i.text.trim() && typeof i.rubric === "string" && i.rubric.trim() &&
        isNum(i.points) && i.points >= 0 && (kind !== "question" || (typeof i.question === "string" && i.question.trim()));
    }).map(function (i) {
      return { text: i.text.trim(), rubric: i.rubric.trim(), points: round2(i.points), question: kind === "question" ? i.question.trim() : null };
    });
  }

  async function importCanned(obj, kind) {
    var label = kind === "general" ? "general" : "question-specific";
    var items = validIssues(obj, kind);
    if (kind === "question" && obj.assignment && norm(obj.assignment) !== norm(S.assignment)) {
      var v = await ask("Different assignment?", [
        "These question-specific issues were saved for “" + obj.assignment + "”, but you're grading “" + S.assignment + "”.",
        "They usually only make sense for the same assignment."
      ], [{ label: "Skip them", value: "skip", kind: "btn-primary" }, { label: "Import anyway", value: "go" }]);
      if (v !== "go") return "Skipped the question-specific issues saved for “" + obj.assignment + "”.";
    }
    // Match rubric columns and questions ignoring capitals and spacing.
    var match = function (name, list) {
      for (var i = 0; i < list.length; i++) if (norm(list[i]) === norm(name)) return list[i];
      return null;
    };
    var cols = S.rubric.map(function (r) { return r.name; });
    var missing = [];
    items.forEach(function (i) {
      var m = match(i.rubric, cols);
      if (m) i.rubric = m;
      else if (missing.indexOf(i.rubric) < 0) missing.push(i.rubric);
    });
    if (missing.length) {
      var n = items.filter(function (i) { return missing.indexOf(i.rubric) >= 0; }).length;
      var a = await ask("Some rubric columns are missing", [
        plural(n, "imported " + label + " issue") + (n === 1 ? " uses" : " use") + " rubric columns that aren't in your list: " + listText(missing) + "."
      ], [{ label: "Add " + (missing.length === 1 ? "that column" : "those columns"), value: "add", kind: "btn-primary" }, { label: "Skip those issues", value: "skip" }]);
      if (a === "add") missing.forEach(function (m) { S.rubric.push({ name: m, max: null }); });
      else items = items.filter(function (i) { return missing.indexOf(i.rubric) < 0; });
    }
    var badQ = [];
    if (kind === "question") {
      items = items.filter(function (i) {
        var m = match(i.question, S.questions);
        if (m) { i.question = m; return true; }
        if (badQ.indexOf(i.question) < 0) badQ.push(i.question);
        return false;
      });
    }
    var added = 0, dup = 0;
    items.forEach(function (i) {
      var pool = kind === "general" ? S.canned.filter(function (c) { return c.scope === "general"; }) : visibleCanned(i.question);
      if (pool.some(function (c) { return c.rubric === i.rubric && norm(c.text) === norm(i.text); })) { dup++; return; }
      S.canned.push({ id: uid("c"), text: i.text, rubric: i.rubric, points: i.points,
        scope: kind === "general" ? "general" : "question", question: i.question });
      added++;
    });
    persist();
    updateChrome();
    var msg = "Imported " + plural(added, label + " canned issue") + ".";
    if (dup) msg += " " + dup + (dup === 1 ? " was" : " were") + " already in your list.";
    if (badQ.length) msg += " Skipped issues for questions not in this assignment: " + listText(badQ) + ".";
    return msg;
  }

  function wireLibraryImport(kind) {
    var input = $("lib-imp-" + kind), status = $("lib-imp-" + kind + "-status");
    input.addEventListener("change", async function () {
      var f = input.files[0];
      status.classList.remove("error-text");
      status.textContent = "";
      if (!f) return;
      try {
        var obj = await readJson(f);
        var k = cannedKind(obj);
        if (k !== kind) {
          throw new Error(k === "session" ? "That's a full session file, not a canned-issues file." :
            k ? "That's a " + (k === "general" ? "general" : "question-specific") + " issues file. Use the other box." :
            "That isn't a canned-issues file from the grading assistant.");
        }
        status.textContent = await importCanned(obj, kind);
        renderLibrary();
      } catch (e) {
        status.textContent = e.message;
        status.classList.add("error-text");
      } finally {
        input.value = "";
      }
    });
  }

  /* ---------- Report and exports ---------- */
  function computeOff() {
    var out = {};
    S.students.forEach(function (s) {
      out["s:" + s] = {};
      S.rubric.forEach(function (r) { out["s:" + s]["r:" + r.name] = 0; });
    });
    S.records.forEach(function (r) {
      var row = out["s:" + r.student];
      if (!row || S.questions.indexOf(r.question) < 0) return;
      r.issues.forEach(function (i) {
        if (("r:" + i.rubric) in row) row["r:" + i.rubric] += i.points;
      });
    });
    return out;
  }
  function gradedCount(s) {
    return S.questions.filter(function (q) { return statusOf(q, s) === "graded"; }).length;
  }

  function renderReport() {
    var body = $("report-body");
    body.replaceChildren();
    var off = computeOff();
    var total = S.students.length * S.questions.length;
    var graded = S.students.reduce(function (a, s) { return a + gradedCount(s); }, 0);
    var anyMax = S.rubric.some(function (r) { return r.max != null; });
    var sumMax = S.rubric.reduce(function (a, r) { return a + (r.max || 0); }, 0);
    body.append(h("p", { class: graded === total ? "meta" : "warn", text: graded === total ?
      "All " + total + " answers are marked graded." :
      graded + " of " + total + " answers are marked graded so far, so these totals may still change." }));
    if (anyMax && S.rubric.some(function (r) { return r.max == null; })) {
      body.append(h("p", { class: "meta", text: "Columns without a max only count toward points off, not the score." }));
    }
    var tbody = h("tbody");
    S.students.forEach(function (s) {
      var row = off["s:" + s], allOff = 0, score = 0;
      var cells = S.rubric.map(function (r) {
        var o = round2(row["r:" + r.name]);
        allOff += o;
        if (r.max != null) score += Math.max(0, r.max - o);
        return h("td", { class: "num" }, o ? minus(o) : "0", r.max != null ? h("span", { class: "sub", text: fmt(Math.max(0, r.max - o)) + " of " + fmt(r.max) }) : null);
      });
      tbody.append(h("tr", null, h("th", { scope: "row", text: s }), cells,
        h("td", { class: "num", text: allOff ? minus(allOff) : "0" }),
        anyMax ? h("td", { class: "num", text: fmt(score) + " of " + fmt(sumMax) }) : null,
        h("td", { class: "num", text: gradedCount(s) + " of " + S.questions.length })));
    });
    body.append(h("div", { class: "table-scroll", role: "region", "aria-label": "Points off per student and rubric column", tabindex: "0" },
      h("table", { class: "data" },
        h("caption", { class: "visually-hidden", text: "Points off per student and rubric column" }),
        h("thead", null, h("tr", null, h("th", { scope: "col", text: "Student" }),
          S.rubric.map(function (r) { return h("th", { scope: "col", class: "num", text: r.name + " off" }); }),
          h("th", { scope: "col", class: "num", text: "Total off" }),
          anyMax ? h("th", { scope: "col", class: "num", text: "Score" }) : null,
          h("th", { scope: "col", class: "num", text: "Graded" }))),
        tbody)));
    $("scores-download").hidden = !anyMax;
    $("scores-hint").hidden = anyMax;
  }

  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets reading text as a formula
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) {
    return "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  // Points deducted per rubric column, for every column.
  function deductionsCsv() {
    var off = computeOff();
    var head = ["Student"].concat(S.rubric.map(function (r) { return r.name + " points off"; }),
      ["Total points off", "Answers marked graded (of " + S.questions.length + ")"]);
    var rows = S.students.map(function (s) {
      var allOff = 0;
      var row = [s].concat(S.rubric.map(function (r) {
        var o = round2(off["s:" + s]["r:" + r.name]);
        allOff += o;
        return o;
      }));
      return row.concat([round2(allOff), gradedCount(s)]);
    });
    return toCsv([head].concat(rows));
  }

  // Scores (max minus points off, never below 0), only for columns that have a max.
  function scoresCsv() {
    var off = computeOff();
    var cols = S.rubric.filter(function (r) { return r.max != null; });
    var sumMax = cols.reduce(function (a, r) { return a + r.max; }, 0);
    var head = ["Student"].concat(cols.map(function (r) { return r.name + " (out of " + fmt(r.max) + ")"; }),
      ["Total (out of " + fmt(sumMax) + ")"]);
    var rows = S.students.map(function (s) {
      var total = 0;
      var row = [s].concat(cols.map(function (r) {
        var sc = round2(Math.max(0, r.max - off["s:" + s]["r:" + r.name]));
        total += sc;
        return sc;
      }));
      return row.concat([round2(total)]);
    });
    return toCsv([head].concat(rows));
  }

  function logCsv() {
    var rows = [["Student", "Question", "Rubric column", "Points off", "Issue", "Kind"]];
    S.students.forEach(function (s) {
      S.questions.forEach(function (q) {
        var r = rec(q, s);
        if (!r) return;
        r.issues.forEach(function (i) {
          rows.push([s, q, i.rubric, i.points, i.text, i.cannedId ? "Canned" : i.studentSpecific ? "Student-specific" : "Not in canned list"]);
        });
      });
    });
    return toCsv(rows);
  }

  function questionIssuesJson() {
    var issues = S.canned.filter(function (c) { return c.scope !== "general" && c.question; }).map(function (c) {
      return { question: c.question, rubric: c.rubric, text: c.text, points: c.points };
    });
    return { format: FMT.question, version: 1, assignment: S.assignment, exportedAt: new Date().toISOString(), issues: issues };
  }
  function generalIssuesJson() {
    var issues = S.canned.filter(function (c) { return c.scope === "general"; }).map(function (c) {
      return { rubric: c.rubric, text: c.text, points: c.points };
    });
    return { format: FMT.general, version: 1, exportedAt: new Date().toISOString(), from: S.assignment, issues: issues };
  }

  function doDownload(kind, statusEl) {
    var base = slug(S.assignment), msg;
    if (kind === "deductions") {
      download(base + "-points-deducted-" + stamp() + ".csv", deductionsCsv(), "text/csv;charset=utf-8");
      msg = "Points deducted downloaded.";
    } else if (kind === "scores") {
      download(base + "-scores-" + stamp() + ".csv", scoresCsv(), "text/csv;charset=utf-8");
      var noMax = S.rubric.filter(function (r) { return r.max == null; }).map(function (r) { return r.name; });
      msg = "Scores downloaded." + (noMax.length ? " " + listText(noMax) + (noMax.length === 1 ? " has" : " have") + " no max, so " + (noMax.length === 1 ? "it isn't" : "they aren't") + " in it." : "");
    } else if (kind === "log") {
      download(base + "-issues-per-student-" + stamp() + ".csv", logCsv(), "text/csv;charset=utf-8");
      msg = "Issue list downloaded.";
    } else if (kind === "question") {
      var qj = questionIssuesJson();
      var fresh = S.canned.filter(function (c) { return c.scope === "unreviewed"; }).length;
      download(base + "-question-specific-issues-" + stamp() + ".json", JSON.stringify(qj, null, 2), "application/json");
      msg = "Downloaded " + plural(qj.issues.length, "question-specific issue") + "." +
        (fresh ? " That includes " + plural(fresh, "new issue") + " not sorted yet, which count as question-specific until you review them." : "");
    } else {
      var gj = generalIssuesJson();
      download("general-canned-issues-" + stamp() + ".json", JSON.stringify(gj, null, 2), "application/json");
      msg = "Downloaded " + plural(gj.issues.length, "general issue") + ".";
    }
    if (statusEl) statusEl.textContent = msg + " Check your browser's downloads.";
  }

  function exportSessionObj(o) {
    download(slug(o.assignment) + "-grading-session-" + stamp() + ".json", JSON.stringify(o, null, 2), "application/json");
  }
  function exportSession() {
    S.exportedAt = new Date().toISOString();
    S.exportDirty = false;
    persist(false);
    exportSessionObj(S);
    announce("Everything exported. Check your browser's downloads.");
    $("save-status").textContent = "Exported " + timeStr(S.exportedAt);
  }

  async function closeSession() {
    var v = await ask("Close this session?", [
      S.exportDirty ? "You've made changes since your last export. Without an export, they'll be gone once this browser's copy is cleared." :
        "Your last export (" + timeStr(S.exportedAt) + ") has everything.",
      "Your canned issues are in that export too, or download them on the Report page first."
    ], [
      { label: "Export everything, then close", value: "export", kind: "btn-primary" },
      { label: "Close without exporting", value: "go" },
      { label: "Cancel", value: null }
    ]);
    if (!v) return;
    if (v === "export") exportSession();
    clearStored();
    S = null;
    clearForm();
    updateChrome();
    $("notice").hidden = true;
    show("start");
    announce("Session closed.");
  }

  /* ================= Wiring ================= */
  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("#app-nav [data-screen]"), function (b) {
      b.addEventListener("click", async function () {
        if (!(await guardForm())) return;
        if (b.dataset.screen === "grade") clearForm();
        show(b.dataset.screen);
      });
    });
    $("export-all").addEventListener("click", exportSession);
    $("notice-close").addEventListener("click", function () { $("notice").hidden = true; $("main").focus(); });

    $("issue-form").addEventListener("submit", function (e) { e.preventDefault(); submitIssue(); });
    $("add-card").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitIssue(); }
    });
    $("issue-clear").addEventListener("click", function () { clearForm(); $("issue-text").focus(); });
    ["issue-text", "issue-points"].forEach(function (id) { $(id).addEventListener("input", updateLinkStatus); });
    ["issue-rubric", "issue-specific"].forEach(function (id) { $(id).addEventListener("change", updateLinkStatus); });
    $("auto-copy").addEventListener("change", function () { S.prefs.autoCopy = $("auto-copy").checked; persist(false); });

    $("save-next").addEventListener("click", saveNext);
    $("prev-answer").addEventListener("click", prevAnswer);
    $("finish-question").addEventListener("click", async function () {
      if (await guardForm()) openReview(S.position.question);
    });
    $("jump-question").addEventListener("change", async function () {
      var q = $("jump-question").value;
      if (!(await guardForm())) { $("jump-question").value = S.position.question; return; }
      goTo(q, S.position.student);
    });
    $("jump-student").addEventListener("change", async function () {
      var s = $("jump-student").value;
      if (!(await guardForm())) { $("jump-student").value = S.position.student; return; }
      goTo(S.position.question, s);
    });

    $("lib-filter").addEventListener("change", function () { libFilter = $("lib-filter").value; renderLibrary(); });
    wireLibraryImport("general");
    wireLibraryImport("question");
    Array.prototype.forEach.call(document.querySelectorAll("[data-download]"), function (b) {
      b.addEventListener("click", function () {
        doDownload(b.dataset.download, b.closest(".card").querySelector(".dl-status"));
      });
    });

    $("resume-btn").addEventListener("click", function () {
      var stored = loadStored();
      if (!stored) { renderStart(); return; }
      S = stored;
      updateChrome();
      $("save-status").textContent = "Saved in this browser " + timeStr(S.savedAt);
      show("grade");
    });
    $("discard-btn").addEventListener("click", async function () {
      var stored = loadStored();
      if (!stored) { renderStart(); return; }
      var v = await ask("Clear the session saved in this browser?", [
        "This removes “" + stored.assignment + "” from this browser. Export it first if you might still need it."
      ], [
        { label: "Export it, then clear", value: "export", kind: "btn-primary" },
        { label: "Clear without exporting", value: "go" },
        { label: "Cancel", value: null }
      ]);
      if (!v) return;
      if (v === "export") exportSessionObj(stored);
      clearStored();
      renderStart();
      $("start-title").focus();
      announce("Cleared.");
    });
    $("open-session-file").addEventListener("change", async function (e) {
      var input = e.target, f = input.files[0], err = $("open-error");
      err.textContent = "";
      if (!f) return;
      try {
        var s = normalizeSession(await readJson(f));
        if (!(await replaceStoredOk(s))) return;
        S = s;
        S.exportDirty = false;
        persist(false);
        updateChrome();
        show("grade");
        announce("Opened “" + S.assignment + "”.");
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        input.value = "";
      }
    });
    $("close-session").addEventListener("click", closeSession);

    enhanceFileInputs(document);
    // A file dropped outside a drop zone would make the browser open it and leave the app, losing an unsaved form.
    ["dragover", "drop"].forEach(function (type) {
      window.addEventListener(type, function (e) {
        var t = e.target;
        if (!(t && t.type === "file")) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; }
      });
    });

    show("start", false);
  }

  init();
})();
