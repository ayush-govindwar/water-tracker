# Water Tracker

Tray app. She walks in at the bottom-right corner (above the taskbar) every 30 min, drinks, and asks you to drink too. **I drank it** counts and resets to 30 min, **Snooze** re-fires in 5 min.

```
npm install
npm start            # run
npm test             # scheduler unit tests (fake clock)
npm run test:e2e     # drives the real Electron app (fake clock, isolated profile)
npm run dist         # on Windows: NSIS installer + portable exe -> dist/ (x64)
npm run dist:cross   # on mac/linux: same, but skips exe icon/metadata (needs wine otherwise)
```

## Character
She's a layered vector SVG rig (`src/overlay/index.html`, palette + 300×340 widget from the design reference), animated part by part with CSS keyframes in `src/overlay/overlay.css`:

| state | what she does |
|---|---|
| `peek` | walks in from the screen edge, waves, says hi (time/streak aware) |
| `loop` | lifts the glass, sips, "ahh", then waves at you: "Your turn!" |
| `exit-happy` | "I drank it": the cheer pose, hops, walks off |
| `exit-goal` | same + confetti when you hit the daily goal |
| `exit-sulk` | "Snooze": pouts, sad brows, a tear, shuffles off |
| `love` | 11:11 + one random time 9–5: pops up, winks, blows a kiss, heart flies |

Tap her while she waits: she giggles. Only the card and her body take clicks; the rest of the window clicks through.

## Perks
- Progress cups on the card, fills as you drink.
- Tray: Remind me now · Undo last drink · Pause for 1 hour / Resume · Settings · Quit.
- Surprise heart twice a day (toggle in Settings).

## Performance
Idle = main process + tray only: the overlay window is created when she appears and destroyed 30 s after she leaves. Store reads are served from memory (no disk I/O per tick). Animations are transform/opacity only (GPU compositor).

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
