# Real chart interaction demo

[GIF](chart-demo.gif) · [MP4](chart-demo.mp4)

Recorded on 2026-10-01 from the running public-preview workspace, using an isolated agent-browser session and a local development server on port 5293. No program source, chart data, UI text, or FPS counters were changed for this capture.

## What is shown

- Real mouse-wheel chart zoom, mouse-drag panning, and reverse wheel zoom.
- Native MA, Bollinger Bands, volume, MACD, and RSI panes, including their actual divergence annotations.
- One native indicator-library dialog: filter Bollinger Bands, view its chart-derived preview, then restore the catalogue.

The retained sequence lasts 8 seconds and loops from the catalogue back to the initial chart. Setup, loading, and the later return-to-chart operation are outside the clip.

## Data source

**Binance BTCUSDT USDT-margined perpetual, 1h, public market data.** The application loaded 1,000 recent candles and received its ordinary live updates. The recording does not use simulation, substituted responses, planted prices, or a synthetic UI. Displayed historical candles and indicators are the app's actual output. Prices are capture-time observations rather than a recommendation or a performance claim.

## Capture and export

| Property | Value |
| --- | --- |
| Source browser viewport | 1280 × 800, DPR 1 |
| Retained native screen captures | 128 frames over approximately 8 seconds, about 16 unique captures/second |
| GIF | 960 × 600; 8.00 seconds; 144 frames; average 18 encoded frames/second; loops indefinitely |
| GIF size | 2,670,129 bytes (2.55 MiB) |
| MP4 | H.264, 960 × 600; 8.00 seconds; 144 frames at 18fps; silent |
| MP4 size | 542,747 bytes (530 KiB) |

The sequence uses actual agent-browser screenshots taken during real input actions, assembled using their recorded wall-clock intervals. Export only resizes, compresses, and resamples frame timing by repeating or dropping captured frames. It does not synthesize motion, speed up the interactions, add promotional graphics, or fabricate chart content. **File encoding rate and recording sample rate are separate from the application's render FPS. This is a feature demonstration, not a rendering benchmark.**

The GIF's 144 frame delays total 8,000ms (80 × 60ms and 64 × 50ms), giving 18fps on average despite GIF timing quantization. MP4 metadata also reports 8.00 seconds and 18fps. Representative chart and dialog frames were decoded and visually checked after encoding.

## Integrity

- `chart-demo.gif`: SHA-256 `aba19fb53e6d2e9c9850126768ac52534acb03b2fce342f1f1e2c69f3d67a4df`
- `chart-demo.mp4`: SHA-256 `fdab0f774393e79053f63d67340324f3205de90ab7695138b2639d080e15ec59`

The dedicated recording browser and port-5293 server were stopped after capture. The existing port-5199 application was left running.
