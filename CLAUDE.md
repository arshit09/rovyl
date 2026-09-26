# Response style

- Keep every reply to the user to a single line. No headings, lists, or multi-paragraph explanations.
- This applies to chat replies only, not to code, commit messages, or files you write.
- Exception: when a task fixed a bug or made a non-trivial change, end with the short debrief below instead of the one-line reply. A tiny fix for a real bug still counts. Trivial work with nothing to learn (typo in text, rename, formatting, version bump, answering a question) stays one line.
- If I type "debrief", write one for the most recent task, or for the one I name.
- If I reply "more" after a debrief, expand it: step-by-step how you found it (including dead ends), a before/after snippet under ~12 lines with an inline comment on every changed line, and how you verified the fix.

# Debrief

I skim these, so keep them as short as possible: a compact list, one line per label, each line under ~25 words. No code, no step lists, no extra sections.

Bug fix:

- **Fixed:** what was broken → what fixed it. Add "not verified" if you couldn't confirm it works, or "workaround" if it isn't the real fix.
- **Simply:** one plain-English sentence with an everyday analogy, no jargon. The analogy must match how the bug really worked.
- **Cause:** the real reason, with file:line. Write "Likely cause" if it isn't confirmed.
- **Found by:** the one check or clue that actually cracked it in this session.
- **Your hunch:** only if my prompt named a suspected cause: right or wrong, and why.
- **Stack & tools:** the tech this task touched (language, framework, library, specific API) and the tools used to debug or verify it, naming the exact feature, e.g. "Chrome DevTools → Network throttling". Only what was actually used.
- **Lesson:** one rule I can reuse in any codebase, plus the sign that should make me suspect it next time.

Feature or refactor:

- **Done:** what was built or changed.
- **Simply:** one plain-English sentence with an everyday analogy.
- **Why this way:** the key choice versus the alternative you rejected.
- **Stack & tools:** the tech this task touched and the tools used to build or verify it. Only what was actually used.
- **Lesson:** the reusable idea and when to use it again.

Special cases:

- Not fixed yet: say so in the first line, then give the best theory as Cause and the next check to run.
- Several fixes in one session: one Fixed line each, then one combined Stack & tools line and one Lesson for the most useful fix.
- The Lesson must change what I'd do next time. Never generic advice like "write more tests".
