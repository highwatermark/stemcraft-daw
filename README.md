# TAPE-4 // StemCraft DAW

**Browser-based 4-deck Lo-Fi Audio Mixing & Neural Stem Separation DAW** combining Web Audio API hardware-style effects, multi-stage neural source separation (`BS-RoFormer` + `Mel-RoFormer Karaoke` + `HTDemucs v4`), YouTube extraction & style cloning, Carnatic/Lo-Fi/House beat synthesis, real-time `AudioWorklet` voice tuning, Gemini AI remix planning, and offline stereo WAV mixdown export.

---

## Architecture Overview

| Layer | Technology | Role |
|---|---|---|
| **Backend Server** | Node.js, Express 5, `youtube-dl-exec` (`yt-dlp`), `ffmpeg-static` | YouTube audio extraction, persistent project library indexing, disk slicing/transcoding, static hosting, and Gemini API orchestration. |
| **Neural Stem & Style Worker** | Persistent Python stdio daemon ([`stem_worker.py`](stem_worker.py)), `audio-separator`, PyTorch MPS / CoreML ONNX | Hardware-accelerated source separation (`BS-RoFormer` SDR 12.97, `Mel-RoFormer Karaoke` SDR 10.20, `HTDemucs v4`) plus STFT/chroma BPM, key/scale, swing, and drum-pocket groove analysis. |
| **Frontend DAW Engine** | Vanilla ES6+, Web Audio API (`BiquadFilterNode`, `ConvolverNode`, `AnalyserNode`, `OfflineAudioContext`), `AudioWorkletNode` | 4-deck interactive mixer, zoomed scrollable waveforms, sub-region loop/trim, real-time spectrum analyzer, voice pitch/scale tuner, multi-genre beat synthesizer, Component Mix Studio, and WAV bounce. |

---

## Key Features

### 1. 4-Deck Hardware-Style Mixing & Precision Editing
- **4 Independent Tape Decks** with drag-and-drop local audio loading (`MP3`, `WAV`, `OGG`, `M4A`), YouTube URL extraction, or Library loading.
- **Per-Deck DSP Chain** (`AudioWorkletNode` Voice Tuner -> `2.8 kHz` Presence Peaking EQ -> Stereo Doubler -> `2000 Hz` Low-Pass Lo-Fi Filter -> Equal-Power Custom `ConvolverNode` Reverb -> Volume Gain -> Master Bus).
- **Zoomable, Scrollable Waveform & Sub-Region Editor**:
  - Zoom (`1x–16x`), pan/scrub playhead directly on canvas, set exact `IN` / `OUT` boundaries with timestamps or `±0.1s` nudge buttons, toggle `LOOP SEL`, crop/trim (`TRIM`), remove silence boundaries (`SILENCE`), and restore original audio (`ORIG`).
- **Master Spectrum Visualizer & Offline Mixdown (`BOUNCE MIX`)**:
  - Real-time `AnalyserNode` 20 Hz–20 kHz frequency bar visualizer with peak caps.
  - One-click **`BOUNCE MIX`** renders all active decks via `OfflineAudioContext` (honoring `IN–OUT` loops, stagger delays, pitch/fine tuning, EQ, Lo-Fi filter, reverb wet/dry mix, deck volumes, and peak-clipping protection) into `./library/mixes/<name>__mix-<id>.wav` and triggers a WAV download.

### 2. Clean Multi-Stage Neural Stem Separation
- **`VOICE ONLY`, `MUSIC ONLY`, and `2-STEM` (`BS-RoFormer ep_317 SDR 12.97`)**:
  - Splits any track (or selected `IN–OUT` region) into cleanly separated stereo stems, saved inside dedicated per-track folders under `./library/stems/<track-slug>-<hash>/`:
    - `<track-slug>__vocals.wav`
    - `<track-slug>__instruments.wav`
- **`3-STEM SPLIT` (`BS-RoFormer` -> `Mel-RoFormer Karaoke` -> `HTDemucs v4`)**:
  - Decomposes into combined **Vocals**, **Lead Vocal**, **Chorus / Backing**, **Instruments**, **Drums**, **Bass**, and **Melody (`other`)** while extracting Style DNA (`BPM`, musical key & Carnatic/Western scale, swing ratio, warmth rolloff, and 16-step kick/snare/hat groove patterns).
  - Separates directly from server-indexed library files using `ffmpeg-static` without re-uploading large WAV files from the browser.

### 3. Real-Time Voice Tuner
- Powered by [`public/pitch-worklet.js`](public/pitch-worklet.js) inside each deck:
  - **Pitch Shift**: `-12` to `+12` semitones (speed-independent grain resynthesis).
  - **Fine Tune**: `-50` to `+50` cents.
  - **Auto-Tune Scale Snap**: `OFF`, `SOFT`, or `HARD` quantization across 12 root keys and Chromatic / Major / Minor scales with live detected-vs-target note readout.
  - **Vocal Tone EQ (`2.8 kHz`)** and **Stereo Vocal Doubler**.

### 4. Lo-Fi, Carnatic, House & Orchestral Synthesizer + YT Style Cloner
- Built in [`public/lofi-generator.js`](public/lofi-generator.js) with 12 synthesizers (no static sample loops):
  - **Lo-Fi**: `rhodes`, `drums`, `bass`, `pad`, `vinyl`
  - **Carnatic Fusion**: `nadhaswaram` (formant shehnai/nadaswaram + tanpura drone), `mridangam` (Modal Konnakol/Tala synthesis), `carnatic_lofi`
  - **House / Modern**: `deep_house`, `soul_house`, `bass_drums`, `orchestral`
  - **Scales**: Natural Minor, Major, Dorian, Pentatonic Minor, Carnatic `Mohanam`, `Kalyani`, `Mayamalavagowla`, and `Charukesi`.
- **YouTube Style Cloner (`YT STYLE //`)**: Analyzes an external YouTube reference track's separated backing stems and synthesizes fresh matching loops locked to its extracted BPM, key/scale, swing, and drum groove (`Style Lo-Fi Pocket`, `Carnatic Lo-Fi Flip`, `Drums & Sub Only`, `Deep Chill House`, `Half-Time Ambient`) — or loads its separated clean instrument stem directly.

### 5. Component Mix Studio & Gemini AI Remix Director
- **Gemini AI Remix Director (`/api/remix-plan`)**: Downsamples loaded deck audio to compact 8 kHz mono WAVs (when *Send Audio to Gemini* is checked) and sends per-track & global natural-language prompts to Gemini (`gemini-3.5-flash` with fallback chain) to generate concrete timeline slices, stem toggles, pitch shifts, stagger delays, filter/reverb automation, and companion beat synthesis.
- **Component Mix Studio (`/api/mix-variations`)**: Pairs extracted `Lead Vocal`, `Chorus`, and `Reference Instruments / Style DNA` components across tracks to build multi-option fusion remix presets with one-click audition & apply.

---

## Project Structure

```text
stemcraft-daw/
├── server.js                  # Express API, yt-dlp extraction, library indexing, Python worker IPC, Gemini routes
├── stem_worker.py             # Persistent Python neural separator (BS-RoFormer, Mel-RoFormer, HTDemucs) + Style DNA
├── package.json               # Node dependencies & start script
├── requirements-stems.txt     # Python dependencies for local neural stem separation
├── .env.example               # Template for GEMINI_API_KEY and PORT
├── .gitignore                 # Excludes node_modules, .venv-stems, models-cache, .env, library/, downloads/, audio files
└── public/
    ├── index.html             # HARDWARE/TAPE-4 DAW layout & racks
    ├── styles.css             # Vintage dark-mode console styling
    ├── app.js                 # Web Audio engine, 4-deck mixer, OfflineAudioContext bounce, Library & Studio UI
    ├── vocal-dsp.js           # Client WAV encoding, sub-region slicing, silence trimming & fallback STFT DSP
    ├── pitch-worklet.js       # AudioWorkletProcessor for pitch shift, fine tune & scale-snapped auto-tune
    └── lofi-generator.js      # Procedural multi-genre synthesizer & style-matched beat renderer
```

> **Note:** Extracted audio, separated stems (`./library/stems/`), bounced mixes (`./library/mixes/`), downloaded model checkpoints (`./models-cache/`), Python virtualenvs (`.venv-stems/`), and `.env` secrets are intentionally gitignored and stored only locally on disk.

---

## Setup & Installation

### Prerequisites
- **Node.js** `>= 20` (tested on `v24.4.1`)
- **Python** `3.11–3.13` (recommended on Apple Silicon Macs for PyTorch MPS / CoreML ONNX acceleration)
- `yt-dlp` binary / runtime support handled via `youtube-dl-exec`

### 1. Install Node Dependencies
```bash
npm install
```

### 2. Set Up Local Python Neural Stem Worker (Recommended)
Create `.venv-stems` at the project root (the exact path expected by `server.js`):
```bash
python3 -m venv .venv-stems
source .venv-stems/bin/activate
pip install --upgrade pip
pip install -r requirements-stems.txt
```
On first stem separation, `audio-separator` downloads and caches:
- `model_bs_roformer_ep_317_sdr_12.9755.ckpt`
- `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt`
- `htdemucs.yaml`

into `./models-cache/` (reused across restarts).

### 3. Configure Environment Variables (Optional for Gemini Remix AI)
```bash
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
```
You can also paste a session-only Gemini key directly inside the UI.

### 4. Start the Server
```bash
npm start
```
Open **`http://localhost:3000`** in your browser.

---

## HTTP API Reference

| Method & Endpoint | Description |
|---|---|
| `GET /api/health` | Basic server health and configured port check. |
| `POST /api/extract` | Accepts `{ url }`, validates YouTube URL, extracts best audio via `yt-dlp` -> `.mp3` into `./library/`, caches by video ID, and streams audio with `X-Library-Id` & `X-Track-Title` headers. |
| `GET /api/library` | Recursively syncs `./library/` (`stems/`, `mixes/`) and `./downloads/` with `library/index.json` and returns metadata items. |
| `GET /api/library/:id/audio` | Streams audio with HTTP byte-range (`206 Partial Content`) seeking; supports `?download=1` for attachment downloads. |
| `POST /api/library/save` | Saves raw uploaded `.wav` / `.mp3` buffers to `./library/` (or `./library/mixes/` for `mix` items). |
| `DELETE /api/library/:id` | Removes an audio item from `index.json` and deletes its file from disk (pruning empty stem directories). |
| `GET /api/stem-engine-status` | Reports availability and cache status of `BS-RoFormer`, `Mel-RoFormer Karaoke`, and `HTDemucs`. |
| `POST /api/separate-stems` | Runs 2-stem or multi-stem neural separation from either `{ libraryId, startSec, endSec, stemMode, splitInstruments }` JSON or raw binary `audio/wav`, saving labeled stems into `./library/stems/<track-slug>/`. |
| `POST /api/analyze-style` | Slices an audio clip from a library item, optionally separates stems first, and returns groove/key/BPM/drum Style DNA. |
| `GET /api/gemini-status` | Returns whether `GEMINI_API_KEY` is configured on the server. |
| `POST /api/remix-plan` | Calls `@google/genai` with track metadata (+ optional 8 kHz WAV audio) to return a structured JSON multi-track remix arrangement. |
| `POST /api/mix-variations` | Generates up to 6 structured multi-stem Lo-Fi/fusion preset configurations combining user-selected Lead, Chorus, and Instrument/Beat stems. |
