# psp-toolkit

A browser tool for PSP and PS1 disc images and saves: CSO/ZSO/ISO conversion, PS1 → EBOOT.PBP,
patching (IPS, PPF, BPS, xdelta/VCDIFF), and PS1 save conversion (GME, MCR, VMP). It ships as one
self-contained `dist/index.html`, deployed to GitHub Pages from `main`.

## Nothing leaves the user's machine

Everything runs client-side. No server, no uploads, no telemetry. The one network call is the
opt-in artwork fetch, and it stays off by default. A feature that needs a backend does not fit
this project; say so instead of building one.

The offline build has to keep working from `file://`, with no install. Do not add a runtime
dependency that needs a network fetch or a separate file next to `index.html`.

## Game data is never in this repository

No commercial disc image, BIOS, firmware file or real user save is committed. Test fixtures are
small synthetic files made by `scripts/generate-*-fixtures.js`. When a real file is the only way
to check something, take the path as an argument (as `scripts/verify-vmp-oracle.cjs` does) and
never hardcode a path on one machine.

## How the build fits together

`build.js` bundles each `*-worker.js` with esbuild and inlines them, the UI partials in `ui/` and
`style.css` into `app.html` at its `__WORKERS__`, `__SCRIPTS__` and `__STYLES__` markers.

Adding a worker touches `build.js` in three spots (the `bundleWorker` list, the `__*_WORKER`
global, and the `new Worker('…')` replacement table) and the `COPY` lines in `Dockerfile.test`. A
new top-level source directory needs a `COPY` line too. Miss `Dockerfile.test` and every local
run passes while CI fails, because CI builds inside that image.

Heavy work (compression, hashing, patching) runs in a Web Worker. Files can be over 1 GB: stream
or work in blocks, never hold a whole disc image in one buffer twice.

## Shell commands — one operation per call

Run **one logical command per Bash call.** Do not chain distinct operations with `&&`, `;` or
newlines, and do not bundle a heredoc that writes a file with the command that reads it.

The operator reads each command before allowing it, and the permission list matches on prefixes
(`git commit`, `npm test`). A chained blob cannot be allowlisted or denied piece by piece.

- `git add`, `git commit` and `git show` are three Bash calls. They can run in parallel.
- Write files (commit messages, scripts) with the Write/Edit tools, never `cat >`. Then one
  command reads the file (`git commit -F <file>`).
- No `node -e '…'` or `python3 -c '…'` logic one-liners. Put the logic in a file.

## Running tests

```sh
npm test                       # unit tests, node:test, test/*.test.js
npm run test:e2e               # Playwright, Chromium + Firefox, this machine's baselines
npm run test:e2e:docker        # the same suite inside Dockerfile.test — what CI runs
npm run test:e2e:update        # rewrite this machine's (darwin) screenshot baselines
npm run test:e2e:update:docker # rewrite the linux baselines CI compares against
```

Screenshot baselines exist per browser and per platform (`*-chromium-darwin.png`,
`*-firefox-linux.png`). A change that moves the layout needs both sets updated, and the linux
set only comes from Docker. Look at a changed baseline before committing it.

## Testing strategy — assert behaviour, at the right altitude

- **Formats — assert bytes against an independent source.** A codec or container test checks
  output against a golden vector from a reference implementation (apollo-psp for VMP signing,
  a real tool's output for a patch format), not against values re-derived from our own reading
  of the format. A test that restates our own understanding stays green when that understanding
  is wrong.
- **Round trips are necessary, not sufficient.** `parse(build(x)) == x` proves the two halves
  agree with each other. Pair it with at least one fixed vector from outside.
- **The UI — assert what the user sees,** through Playwright in `test/e2e/`: drop a file, read
  the result, download it. Keep screenshots for layout; assert behaviour with locators and the
  downloaded bytes.
- Every interactive element an e2e test touches is found by a stable selector, not by its
  position on the page.

Test first where the behaviour is known up front.

## Naming things

Names are for engineers and use the words engineers already know.

- A software concept takes its standard name: cache, buffer, offset, header, block, index,
  checksum, worker, handler.
- A format concept takes the name the format's own documentation or the reference
  implementation uses (`PSISOIMG0000`, `PARAM.SFO`, `ICON0`, the MCR directory frame). Search
  for it before inventing one.
- A function is a verb for what it does (`extractMcr`, `buildVmp`, `wrapGme`). A constant says
  what it is and its unit (`VMP_HEADER_BYTES`, `MCR_SIZE`).
- Matching the code around it does not excuse a bad name. Name the new thing properly and
  rename the old ones the change touches.

## Writing code comments

- Say what the code does and why, not the story of how it got there. No "we tried X first", no
  relating a bug that is now fixed.
- Explain the format generously. Two plain lines on what a field means, and why an offset or
  constant has the value it does, are the expensive part to rediscover.
- **Cite the prior art when you port a behaviour:** the project and the file or function
  (`apollo-psp vmp_resign.c, generateHash()`). Not a line number; those rot.
- Say how sure a constant is. "Cross-confirmed against N titles" and "seen in one dump" are
  different claims; write which one it is.
- Nothing about one developer's local setup.

## Where knowledge goes

Put a fact in the highest place that fails when the fact is wrong: a test, then a fixture or
generator script, then a code comment beside what it describes. `docs/` holds the format
references (`eboot-format.md`, `save-format.md`) and the credit for prior art. Those are for
readers outside this repository, so keep them right when a format change touches them. Do not
add a document as the deliverable of a task.

## Commits

The global rules hold: the subject names the file, function or tab that changed, imperative
verb first, under about 70 characters; why goes in the body; stage files by name. Add a line to
`CHANGELOG.md` for a change a user would notice.
