# Custom theme art (your own images)

Each visual theme can use your own images. This is intentionally left empty —
drop your files here and they'll show up; if a file is missing, the theme falls
back to its built-in CSS look (and the emoji icon).

Per theme (`onepiece`, `akatsuki`):

```
public/theme/onepiece/bg.jpg     # full-screen background (dimmed for readability)
public/theme/onepiece/logo.png   # header logo, shown instead of the emoji
public/theme/akatsuki/bg.jpg
public/theme/akatsuki/logo.png
```

Notes:
- `bg.jpg` is used as a `cover` background with a dark overlay so header text
  stays legible. A large landscape image works best.
- `logo.png` is scaled to ~26px tall in the header (transparent PNG looks best).
- These files are **not committed** by default (see `.gitignore`), and none ship
  with the app — you supply whatever image you have the right to use. Copyright
  in any art you add is your responsibility; keep this app private if the art
  isn't yours to distribute.
```
