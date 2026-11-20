# Grading assistant

A small browser tool for grading written assignments consistently and quickly.
You grade one student × question answer at a time. Every issue you write becomes a
**canned issue** you can pick from a dropdown the next time the same mistake turns
up, so it always gets the same wording and the same deduction.

It's three static files (`index.html`, `app.js`, `style.css`). No build step, no
server, no accounts: open `index.html` in a browser, or host the folder on GitHub
Pages.

## Privacy

Student names and grades never leave your computer. The tool autosaves to your
browser's local storage and exports to files you download. The only network
request is for the Google Fonts stylesheet; if it's blocked, the page falls back to
system fonts. On a shared computer, use **Setup → Close session** when you finish,
which clears the browser's copy.

## How a grading session goes

1. **Set up.** Enter the assignment name, students (one per line; a pasted
   spreadsheet column works), questions (Q1–Q4 by default) and rubric columns.
   Max points per rubric column is optional; with it, the report also gives scores
   (max minus points off, never below 0, summed across all questions).
   You can also load the rubric columns from a file instead of typing them (see
   *Rubric files* below). Optionally import canned issues saved from an earlier
   session.
2. **Grade.** Questions are graded in order: every student's Q1, then Q2, and so on.
   For each answer:
   - Pick a canned issue from the dropdown for its rubric column. That fills in the
     form; adjust if needed and press **Add issue** (or Ctrl/⌘+Enter).
   - Or type a new issue, choose the rubric column and points, and add it. It's
     saved as a canned issue unless you tick **Student-specific**.
   - Changing the **wording** of a picked issue makes it a new issue.
   - Changing only the **points** keeps it the same issue. If other answers
     already use it, you choose: change every answer, change it from now on only,
     or change just this answer.
   - **Mark graded, next student** moves on. **Copy** puts an issue's text on the
     clipboard for pasting into the student's work (or tick the option to copy every
     issue as you add it).
3. **Review each question.** After the last student, tick the issues that only make
   sense for that question. Everything else becomes a general issue and appears in
   the dropdowns for every later question. New issues stay tied to their question
   until you review them.
4. **Report.** Points off per student and rubric column (and scores, if you set
   maximums), plus downloads.

The **Progress** page shows every answer's status and lets you jump to any of them.
The **Canned issues** page lists them all: change points, change which questions an
issue appears in, delete, import and export.

## Stopping and picking up again

Work autosaves in the browser after every change. To move to another computer or
keep a backup, press **Export everything** (top right) and later use **Open an
exported session** on the start page.

## Files it produces

| Download | Format | Use |
| --- | --- | --- |
| Points deducted | CSV | Per student: points off in each rubric column, total points off, answers marked graded |
| Scores | CSV | Per student: score in each rubric column that has a max, and the total of those. Only offered when at least one column has a max |
| Every issue, per student | CSV | One row per issue: student, question, rubric column, points, text, kind |
| Question-specific issues | JSON | Re-import for the same assignment (regrading, or a co-grader) |
| General issues | JSON | Re-import for any future assignment |
| Rubric (Setup page or new-assignment form) | JSON | Reuse the same rubric columns and maximums next time |
| Export everything | JSON | The full session, to resume later |

CSV files are UTF-8 with a byte-order mark so Excel opens names with accents
correctly. Text cells that start with `=`, `+`, `-` or `@` are prefixed with `'` so a
spreadsheet doesn't treat them as formulas.

JSON shapes:

```json
{ "format": "grading-assistant/general-issues", "version": 1,
  "issues": [{ "rubric": "Style", "text": "Missing citation.", "points": 1.5 }] }

{ "format": "grading-assistant/question-issues", "version": 1, "assignment": "HW3",
  "issues": [{ "question": "Q1", "rubric": "Content", "text": "Vague thesis.", "points": 3 }] }
```

## Rubric files

In the **Rubric columns** section (new-assignment form and Setup page), **Download
this rubric** saves the columns currently in the form, and **Load a rubric from a
file** fills the form from any of these:

- a rubric `.json` downloaded here:
  `{ "format": "grading-assistant/rubric", "version": 1, "rubric": [{ "name": "Content", "max": 10 }, { "name": "Style", "max": null }] }`
- a session export (its rubric columns are used),
- a `.csv` with a column name and (optionally) max points on each line, such as a
  sheet saved from Excel. A header row like `Name,Max` is skipped.

Loading replaces the columns in the form (you're asked first if it isn't empty).
On the Setup page nothing changes until you press **Save changes**; a loaded column
whose name matches an existing one (ignoring capitals) keeps its issues, and you're
asked before any column with issues is removed.

## Importing canned issues

When importing, rubric columns and questions are matched ignoring capitals and
spacing. Issues for a rubric column you don't have can be added as a new column or
skipped. Question-specific issues saved for a different assignment name are skipped
unless you choose to import them anyway. Duplicates are skipped.

## Accessibility

Built to WCAG 2.1 AA: labelled controls, visible focus, keyboard-only use throughout,
a skip link, native modal dialogs, screen reader announcements for actions, status
shown in text and not colour alone, and layouts that work at phone width and 400%
zoom. Checked with axe-core on every screen.
