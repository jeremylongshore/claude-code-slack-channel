# #3 deep-dive lives in the blog repo

The startaitools deep technical dive **"Rent the Agent, Own the Proof"** is staged as a Hugo draft (`draft = true`) in the blog repo, not here:

`~/000-projects/blog/startaitools/drafts/rent-the-agent-own-the-proof/`
- `index.md` — canonical Hugo post (~2,000 words, S2 citations + references)
- `substack.md` · `x-thread.md` · `devto.md` — platform variants

It's in the blog repo so `blog-backfill`/Hugo tooling resolves. Publish = flip `draft = false` and push to `master` (Netlify). Dev.to is the only live cross-post; Substack/X are manual.
