# Reference media (local only)

Everything in this folder except this README and `personas.example.json` is gitignored. It holds
photos and clips of real people who have given explicit consent to have their likeness used as a
persona reference, plus the inputs of the Python research pipeline (`main_stream.py` /
`identity_bank.py --ref_dir ./references`).

## Local personas for the studio

The web app never bundles a real person's photo. Instead, `personas.json` (copy
`personas.example.json`) lists local photos with the consent record of each pictured person:

```json
{ "personas": [ { "id": "persona-x", "name": "X", "category": "men", "file": "x.jpeg", "consent": { ... } } ] }
```

`vite.config.ts` reads that manifest and serves the listed files under `references/` for the dev
server, copies them into `dist/references/` for a local production build (which is what the
desktop installer packages), and injects the entries as `__PL_LOCAL_PERSONAS__`. Their quality
metrics (resolution, sharpness, lighting) are measured from the image when the app loads.

The GitHub Pages build runs in CI, where this folder does not exist, so it ships only the stock
sample personas. `PERSONALIVE_LOCAL_PERSONAS=0 npm run build` reproduces that locally.

## Keep this folder when switching branches

Commits before 168b680 still track these files. Checking such a commit out and coming back deletes
the local copies (git removes files that stop being tracked). Restore them with
`git show <old-commit>:references/<file> > references/<file>` until the history purge in the R0
report has been done.
