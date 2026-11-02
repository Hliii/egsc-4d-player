# EGSC 4D Player

Offline-capable PWA player for EGSC-compressed 4D Gaussian scenes
(FreeTimeGS / A3DGS model, T/UWA 050-2026 EGSC bitstreams).

**Open:** [examples/egsc-demo.html](examples/egsc-demo.html)

- First load caches everything (~24.5 MB scene + player); after that the app
  works fully offline — install it to your home screen and try airplane mode.
- Timeline playback, orbit camera (drag / pinch / wheel), camera roll
  (buttons or `,` / `.` keys), playback speed (select or `+` / `-`).

Provenance: player core from
[FreeTimeGsVanilla](https://github.com/OpsiClear-4DGS/FreeTimeGsVanilla)
(AGPL-3.0) with the EGSC decoder additions; vendored fzstd (MIT) and
texture2ddecoder-wasm (MIT). Scene: `bartender_32f`, 678,832 Gaussians.
