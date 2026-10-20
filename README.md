# Water Tracker

Tray app. A character peeks in from the bottom-right corner (above the taskbar) every 30 min; **I drank** resets to 30 min and counts, **Snooze** re-fires in 5 min.

```
npm install
npm start            # run
npm test             # scheduler unit tests (fake clock)
npm run test:e2e     # drives the real Electron app (fake clock, isolated profile)
npm run dist         # on Windows: NSIS installer + portable exe -> dist/ (x64)
npm run dist:cross   # on mac/linux: same, but skips exe icon/metadata (needs wine otherwise)
```

## Art (phase 4)
Drop four horizontal strips in `assets/sprites/` — cells fixed 96×120, transparent, ~4px padding:

| file | frames | plays |
|---|---|---|
| `peek-in.png` | 8 | once, on appear |
| `drink-loop.png` | 12 | loops while waiting |
| `exit-drank.png` | 10 | once, after "I drank" |
| `exit-snooze.png` | 10 | once, after "Snooze" |

Frame count = image width / 96 (so any count works), 12 fps (`FPS` in `src/overlay/overlay.js`). All four must exist, otherwise the blue placeholder box is used. Shown at 1:1 CSS px; window is 320×150 (`OVERLAY` in `src/main.js`, bubble/char layout in `overlay.css`).

## Behaviour
- One persisted `dueAt`, polled every 10 s plus on resume/unlock → a 2 h sleep gives one reminder.
- Suppressed (stays due, fires when it clears): screen locked, idle ≥ N min, outside active hours.
- Day rollover (local midnight) scores yesterday: goal met & consecutive → streak +1, else 0.
- State lives in electron-store (`%APPDATA%/water-tracker/water-tracker.json`).

## Not verifiable from mac — check once on Windows
1. Overlay over a maximized VS Code while typing: keystrokes keep going to the editor.
2. Box sits above the taskbar (also with taskbar on another edge / 150% scaling).
3. Real sleep/wake (lid close 2+ min with interval lowered in Settings): one reminder after wake.
4. Settings → "Start at login" works for installed and portable builds (portable passes `PORTABLE_EXECUTABLE_FILE`).
5. SmartScreen will warn on unsigned builds.
