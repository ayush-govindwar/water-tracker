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
She comes from real videos in `art/` (black background): `her.mp4` (walk in, stand, drink), `happyafterdrinkingwater.mp4` (cheer), `sulk.mp4` (sad, walks off), `heart.mp4` (walks in, finger hearts). `scripts/video-to-sprites.js` decodes them with Chromium, removes the watermark, keys out the black (flood-fill from the borders, so her black hair/dress survive; hearts/sparkles keep a soft glow), scales every clip to the same height and floor line, and packs each into `assets/her/<clip>.webp` + one `atlas.json`:

```
npx electron scripts/video-to-sprites.js   # re-run after replacing/adding a video
```

Per-clip segments, floor and standing height live in `CLIPS` at the top of the script (edit them if a new video differs). The overlay plays frames on a canvas (`src/overlay/overlay.js`), keeps her in place between clips and crossfades the seams:

| state | built from |
|---|---|
| walk-in | `her.mp4` walk: she enters from the screen edge |
| loop | idle → drink → drink reversed (lowers the tumbler) → idle reversed, with a greeting and "Your turn!" |
| I drank it | `happyafterdrinkingwater.mp4` cheer + sparkles + "Yay!", then mirrored walk frames: walks off right |
| goal reached | same + confetti |
| snooze | `sulk.mp4`: sad face, turns, walks off the screen edge |
| love (11:11 + random 9–5) | `heart.mp4`: walks in, finger hearts + "love you", fades out |

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
