## What changed

<!-- One or two sentences. Link an issue if there is one. -->

## Which MV3 contexts does this touch?

<!-- The four-context split is forced by Chrome, not by taste — violating it is the most
     common way to break this codebase. See the table in CLAUDE.md. -->

- [ ] Popup (Svelte)
- [ ] Service worker
- [ ] Offscreen document
- [ ] Content script
- [ ] Shared `src/lib/` only
- [ ] Build / docs / CI only

## Verification

<!-- There is no test framework; manual verification is the bar. -->

- [ ] `pnpm build` passes (includes `tsc --noEmit`)
- [ ] `pnpm check` passes
- [ ] Exercised against a live animepahe page — downloaded at least one episode end to end
- [ ] `SPEC.md` updated if behaviour or a design decision changed
- [ ] No new Chrome permissions added to `src/manifest.config.ts`
