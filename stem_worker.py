#!/usr/bin/env python3
"""
Local Apple-Silicon Neural Stem Separation & Style Analyzer Worker for TAPE-4 DAW.
Uses audio-separator (BS-RoFormer, Mel-RoFormer Karaoke, HTDemucs) with MPS/CoreML
and numpy/soundfile beat, groove, and key analysis.
"""

import argparse
import json
import os
import sys
import time
import traceback
import numpy as np
import soundfile as sf

DEFAULT_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
KARAOKE_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
DEMUCS_MODEL = "htdemucs.yaml"

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

SCALE_TEMPLATES = {
    "minor": [1.0, 0.0, 0.7, 0.9, 0.0, 0.75, 0.0, 0.95, 0.7, 0.0, 0.8, 0.0],
    "major": [1.0, 0.0, 0.7, 0.0, 0.9, 0.75, 0.0, 0.95, 0.0, 0.7, 0.0, 0.75],
    "mohanam": [1.0, 0.0, 0.85, 0.0, 0.9, 0.0, 0.0, 0.95, 0.0, 0.8, 0.0, 0.0],
    "kalyani": [1.0, 0.0, 0.75, 0.0, 0.9, 0.0, 0.85, 0.95, 0.0, 0.7, 0.0, 0.8],
    "mayamalavagowla": [1.0, 0.9, 0.0, 0.0, 0.9, 0.75, 0.0, 0.95, 0.85, 0.0, 0.0, 0.85],
    "charukesi": [1.0, 0.0, 0.75, 0.0, 0.9, 0.75, 0.0, 0.95, 0.8, 0.0, 0.8, 0.0],
}


def get_separator(separator_cache: dict, model_dir: str, out_dir: str, model_name: str):
    from audio_separator.separator import Separator

    os.makedirs(model_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    models_map = separator_cache.setdefault("models", {})
    sep = models_map.get(model_name)
    if sep is None:
        # Cap warm cache at 3 models (~1.5 GB total)
        if len(models_map) >= 3:
            oldest_key = next(iter(models_map))
            del models_map[oldest_key]
        sep = Separator(
            output_dir=out_dir,
            model_file_dir=model_dir,
            output_format="WAV",
        )
        sep.load_model(model_name)
        models_map[model_name] = sep
    else:
        sep.output_dir = out_dir
        if getattr(sep, "model_instance", None) is not None:
            sep.model_instance.output_dir = out_dir
    return sep


def classify_outputs(output_dir: str, out_files: list[str]) -> dict:
    found = {}
    markers = [
        ("vocals", ["(vocals)", "_vocals"]),
        ("instrumental", ["(instrumental)", "(no_vocals)", "accompaniment"]),
        ("drums", ["(drums)"]),
        ("bass", ["(bass)"]),
        ("other", ["(other)"]),
        ("guitar", ["(guitar)"]),
        ("piano", ["(piano)"]),
    ]
    for f in out_files:
        full = f if os.path.isabs(f) else os.path.join(output_dir, f)
        low = os.path.basename(full).lower()
        # Pick whichever stem tag appears LAST in the filename so parent stem names never shadow child stem tags
        best_pos = -1
        best_key = None
        for key, needles in markers:
            for needle in needles:
                pos = low.rfind(needle)
                if pos > best_pos:
                    best_pos = pos
                    best_key = key
        if best_key:
            found[best_key] = full
    return found


def read_mono_cap(path: str, max_sec: float = 45.0) -> tuple[np.ndarray, int]:
    info = sf.info(path)
    sr = int(info.samplerate)
    max_frames = int(max_sec * sr)
    data, sr = sf.read(path, frames=max_frames, dtype="float32")
    if data.ndim > 1:
        mono = np.mean(data, axis=1)
    else:
        mono = data
    return mono, int(sr)


def compute_rms(path: str) -> float:
    if not path or not os.path.exists(path):
        return 0.0
    mono, _ = read_mono_cap(path, max_sec=60.0)
    if mono.size == 0:
        return 0.0
    return round(float(np.sqrt(np.mean(mono ** 2))), 5)


def analyze_style_from_paths(
    inst_path: str,
    drums_path: str | None = None,
    bass_path: str | None = None,
    other_path: str | None = None,
) -> dict:
    mono_inst, sr = read_mono_cap(inst_path, max_sec=45.0)
    if mono_inst.size < sr // 2:
        return {
            "bpm": 80,
            "keyIndex": 9,
            "keyName": "A",
            "scale": "minor",
            "keyConfidence": 0.0,
            "swingRatio": 0.12,
            "warmthCutoffHz": 2400,
            "bassDensity": 0.5,
            "drumDensity": 0.5,
            "kickPattern": [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 0, 0, 0],
            "snarePattern": [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
            "hatPattern": [0.7, 0.3, 0.6, 0.3, 0.7, 0.3, 0.6, 0.4, 0.7, 0.3, 0.6, 0.3, 0.7, 0.3, 0.65, 0.4],
            "recommendedPreset": "carnatic_lofi",
        }

    # Choose best source for drum onset extraction
    if drums_path and os.path.exists(drums_path):
        mono_drums, sr_d = read_mono_cap(drums_path, max_sec=45.0)
        if np.sqrt(np.mean(mono_drums ** 2)) < 0.002:
            mono_drums = mono_inst
            sr_d = sr
    else:
        mono_drums = mono_inst
        sr_d = sr

    # 1. STFT multiband onset flux on drums/rhythm
    win_d = 1024
    hop_d = 512
    n_frames = max(1, 1 + (len(mono_drums) - win_d) // hop_d)
    if n_frames < 16:
        n_frames = 16
        mono_drums = np.pad(mono_drums, (0, win_d + n_frames * hop_d))

    frames = np.lib.stride_tricks.sliding_window_view(mono_drums, win_d)[::hop_d]
    window = np.hanning(win_d).astype(np.float32)
    spec = np.abs(np.fft.rfft(frames * window, axis=1))
    freqs_d = np.fft.rfftfreq(win_d, d=1.0 / sr_d)

    low_mask = (freqs_d >= 35) & (freqs_d <= 165)
    mid_mask = (freqs_d > 220) & (freqs_d <= 2200)
    high_mask = (freqs_d >= 4200) & (freqs_d <= 14000)

    low_e = np.log1p(np.sum(spec[:, low_mask] ** 2, axis=1))
    mid_e = np.log1p(np.sum(spec[:, mid_mask] ** 2, axis=1))
    high_e = np.log1p(np.sum(spec[:, high_mask] ** 2, axis=1))

    kick_flux = np.maximum(0.0, np.diff(low_e, prepend=low_e[0]))
    snare_flux = np.maximum(0.0, np.diff(mid_e, prepend=mid_e[0]))
    hat_flux = np.maximum(0.0, np.diff(high_e, prepend=high_e[0]))

    total_flux = kick_flux * 1.4 + snare_flux * 1.1 + hat_flux * 0.45
    total_flux = np.maximum(0.0, total_flux - np.percentile(total_flux, 35))
    total_flux = total_flux - np.mean(total_flux)
    frame_rate = sr_d / float(hop_d)

    # Unbiased autocorrelation BPM search within [64, 130] BPM
    min_lag = max(4, int(round(frame_rate * 60.0 / 130.0)))
    max_lag = min(len(total_flux) // 2, int(round(frame_rate * 60.0 / 64.0)))

    best_bpm = 82.0
    if max_lag > min_lag + 2:
        n_tf = len(total_flux)
        ac_full = np.correlate(total_flux, total_flux, mode="full")[n_tf - 1 :]
        lags = np.arange(min_lag, max_lag + 1)
        overlap = np.maximum(1.0, (n_tf - lags).astype(np.float64))
        scores = np.maximum(0.0, ac_full[lags].astype(np.float64) / overlap)
        bpms = 60.0 * frame_rate / lags
        prior = 1.0 - 0.14 * np.abs(np.log2(np.clip(bpms, 60.0, 134.0) / 84.0))
        weighted = scores * prior
        best_pos = int(np.argmax(weighted))
        best_lag = float(lags[best_pos])
        if 0 < best_pos < len(weighted) - 1:
            y0, y1, y2 = weighted[best_pos - 1], weighted[best_pos], weighted[best_pos + 1]
            denom = (y0 - 2.0 * y1 + y2)
            if abs(denom) > 1e-9:
                best_lag += 0.5 * (y0 - y2) / denom
        best_bpm = float(np.clip(60.0 * frame_rate / max(1.0, best_lag), 64.0, 128.0))
        if best_bpm > 118.0 and (best_bpm * 0.5) >= 64.0:
            # Check if half-time has nearly equal periodic support
            half_lag = best_lag * 2.0
            hl_idx = int(round(half_lag)) - min_lag
            if 0 <= hl_idx < len(scores) and scores[hl_idx] >= 0.72 * scores[best_pos]:
                best_bpm = best_bpm * 0.5

    # 2. Extract crisp 16-step quantized groove pattern
    step_sec = (60.0 / best_bpm) / 4.0

    def fold_16(flux_arr: np.ndarray, floor_pct: float = 35.0) -> np.ndarray:
        n = len(flux_arr)
        if n < 16:
            return np.linspace(1, 0, 16)
        step_f = step_sec * frame_rate
        bins = np.zeros(16, dtype=np.float64)
        counts = np.zeros(16, dtype=np.float64) + 1e-6
        max_steps = int(n / step_f)
        for s in range(max_steps):
            center = int(round((s + 0.25) * step_f))
            lo = max(0, center - 1)
            hi = min(n, center + 2)
            if hi > lo:
                bins[s % 16] += float(np.max(flux_arr[lo:hi]))
                counts[s % 16] += 1.0
        avg = bins / counts
        baseline = float(np.percentile(avg, floor_pct))
        span = float(np.max(avg)) - baseline
        if span <= 1e-6:
            return np.zeros(16, dtype=np.float64)
        norm = np.clip((avg - baseline) / span, 0.0, 1.0)
        norm[norm < 0.16] = 0.0
        return norm

    kick_arr = fold_16(kick_flux)
    snare_arr = fold_16(snare_flux)
    hat_arr = fold_16(hat_flux)

    # Rotate phase so strongest kick transient anchors on Beat 1 (step 0)
    if float(np.max(kick_arr)) >= 0.2:
        anchor = int(np.argmax(kick_arr))
        kick_arr = np.roll(kick_arr, -anchor)
        snare_arr = np.roll(snare_arr, -anchor)
        hat_arr = np.roll(hat_arr, -anchor)

    kick_pat = [round(float(v), 2) for v in kick_arr]
    snare_pat = [round(float(v), 2) for v in snare_arr]
    hat_pat = [round(float(v), 2) for v in hat_arr]

    # Ensure rhythmic continuity if reference clip had sparse percussive fills
    if sum(1 for v in kick_pat if v >= 0.2) < 2:
        kick_pat = [1.0, 0, 0, 0.35, 0, 0, 0.5, 0, 0.85, 0, 0.45, 0, 0, 0, 0, 0]
    if sum(1 for v in snare_pat if v >= 0.2) < 2:
        snare_pat = [0, 0, 0, 0, 0.88, 0, 0, 0.22, 0, 0, 0, 0, 0.92, 0, 0, 0.25]
    if sum(1 for v in hat_pat if v >= 0.2) < 4:
        hat_pat = [0.65, 0.25, 0.55, 0.25, 0.7, 0.25, 0.55, 0.35, 0.65, 0.25, 0.55, 0.25, 0.7, 0.25, 0.6, 0.35]

    odd_hats = float(np.mean([hat_pat[i] for i in range(1, 16, 2)]))
    even_hats = float(np.mean([hat_pat[i] for i in range(0, 16, 2)]))
    swing_ratio = float(np.clip(0.08 + 0.14 * (odd_hats / (even_hats + 0.2)), 0.04, 0.28))

    # 3. Spectral warmth & tonal key estimation
    tonal = mono_inst
    if other_path and os.path.exists(other_path):
        other_m, _ = read_mono_cap(other_path, max_sec=45.0)
        if np.sqrt(np.mean(other_m ** 2)) > 0.003:
            tonal = other_m
    if bass_path and os.path.exists(bass_path):
        bass_m, _ = read_mono_cap(bass_path, max_sec=45.0)
        m_len = min(len(tonal), len(bass_m))
        tonal = tonal[:m_len] + 1.15 * bass_m[:m_len]

    win_t = 4096
    hop_t = 2048
    if len(tonal) < win_t:
        tonal = np.pad(tonal, (0, win_t - len(tonal)))
    t_frames = np.lib.stride_tricks.sliding_window_view(tonal, win_t)[::hop_t]
    t_win = np.hanning(win_t).astype(np.float32)
    t_spec = np.abs(np.fft.rfft(t_frames * t_win, axis=1))
    freqs_t = np.fft.rfftfreq(win_t, d=1.0 / sr)
    mean_spec = np.mean(t_spec, axis=0)

    # Chromagram 55Hz - 1800Hz
    chroma = np.zeros(12, dtype=np.float64)
    pitch_mask = (freqs_t >= 55.0) & (freqs_t <= 1800.0)
    valid_freqs = freqs_t[pitch_mask]
    valid_amps = mean_spec[pitch_mask] ** 1.5
    midi_bins = np.round(69.0 + 12.0 * np.log2(valid_freqs / 440.0)).astype(int) % 12
    for mb, amp in zip(midi_bins, valid_amps):
        chroma[mb] += float(amp)
    chroma_norm = chroma / (np.linalg.norm(chroma) + 1e-8)

    best_score = -1.0
    best_key = 9
    best_scale = "minor"
    for scale_name, tmpl in SCALE_TEMPLATES.items():
        tmpl_arr = np.array(tmpl, dtype=np.float64)
        tmpl_arr /= np.linalg.norm(tmpl_arr) + 1e-8
        for shift in range(12):
            rotated = np.roll(tmpl_arr, shift)
            sc = float(np.dot(chroma_norm, rotated))
            if sc > best_score:
                best_score = sc
                best_key = shift
                best_scale = scale_name

    # Spectral centroid & 90% energy rolloff of full instrumental mix
    i_frames = np.lib.stride_tricks.sliding_window_view(
        mono_inst if len(mono_inst) >= win_t else np.pad(mono_inst, (0, win_t - len(mono_inst))),
        win_t,
    )[::hop_t]
    i_power = np.mean(np.abs(np.fft.rfft(i_frames * t_win, axis=1)) ** 2, axis=0)
    tot_power = float(np.sum(i_power)) + 1e-9
    cum = np.cumsum(i_power) / tot_power
    rolloff_idx = int(np.searchsorted(cum, 0.88))
    warmth_cutoff = int(np.clip(freqs_t[min(rolloff_idx, len(freqs_t) - 1)], 1350, 5200))

    bass_e = float(np.sum(i_power[(freqs_t >= 30) & (freqs_t <= 160)])) / tot_power
    drum_rms = compute_rms(drums_path) if drums_path else 0.0
    inst_rms = compute_rms(inst_path)
    drum_density = round(float(np.clip(drum_rms / max(1e-4, inst_rms), 0.1, 1.0)), 2) if drums_path else 0.55

    if best_scale in ("mohanam", "kalyani", "mayamalavagowla", "charukesi"):
        rec_preset = "carnatic_lofi"
    elif best_bpm >= 112:
        rec_preset = "soul_house" if warmth_cutoff < 3200 else "deep_house"
    elif drum_density > 0.45:
        rec_preset = "rhodes"
    else:
        rec_preset = "pad"

    return {
        "bpm": round(best_bpm, 1),
        "keyIndex": int(best_key),
        "keyName": NOTE_NAMES[best_key],
        "scale": best_scale,
        "keyConfidence": round(float(best_score), 3),
        "swingRatio": round(swing_ratio, 3),
        "warmthCutoffHz": warmth_cutoff,
        "bassDensity": round(float(np.clip(bass_e * 2.5, 0.15, 1.0)), 2),
        "drumDensity": drum_density,
        "kickPattern": kick_pat,
        "snarePattern": snare_pat,
        "hatPattern": hat_pat,
        "recommendedPreset": rec_preset,
    }


def run_2stem_job(separator_cache: dict, model_dir: str, input_path: str, out_dir: str, model_name: str) -> dict:
    t0 = time.time()
    sep = get_separator(separator_cache, model_dir, out_dir, model_name)
    t_ready = time.time()
    out_files = sep.separate(input_path)
    t_done = time.time()

    found = classify_outputs(out_dir, out_files)
    vocals_path = found.get("vocals")
    inst_path = found.get("instrumental")
    if not vocals_path or not inst_path:
        raise RuntimeError(f"Expected Vocals and Instrumental stems, got: {out_files}")

    style_profile = analyze_style_from_paths(inst_path)
    try:
        dur_sec = round(float(sf.info(input_path).duration), 2)
    except Exception:
        dur_sec = None
    return {
        "ok": True,
        "mode": "2stem",
        "model": model_name,
        "durationSec": dur_sec,
        "vocalsPath": vocals_path,
        "instrumentalPath": inst_path,
        "rmsStats": {
            "orig": compute_rms(input_path),
            "vocals": compute_rms(vocals_path),
            "instruments": compute_rms(inst_path),
        },
        "styleProfile": style_profile,
        "loadSec": round(t_ready - t0, 2),
        "separateSec": round(t_done - t_ready, 2),
    }


def run_multistem_job(
    separator_cache: dict,
    model_dir: str,
    input_path: str,
    out_dir: str,
    split_instruments: bool = True,
) -> dict:
    t0 = time.time()

    # Pass 1: Clean Vocals vs Instruments (BS-RoFormer SDR 12.97)
    s_main = get_separator(separator_cache, model_dir, out_dir, DEFAULT_MODEL)
    t_ready = time.time()
    f_main = s_main.separate(input_path)
    cls_main = classify_outputs(out_dir, f_main)
    raw_vocals = cls_main.get("vocals")
    inst_path = cls_main.get("instrumental")
    if not raw_vocals or not inst_path:
        raise RuntimeError(f"BS-RoFormer failed to produce Vocals & Instrumental: {f_main}")

    # Pass 2: Lead Vocal vs Chorus / Backing Harmonies (Mel-RoFormer Karaoke)
    voc_dir = os.path.join(out_dir, "vocal_sub")
    s_kar = get_separator(separator_cache, model_dir, voc_dir, KARAOKE_MODEL)
    f_kar = s_kar.separate(raw_vocals)
    cls_kar = classify_outputs(voc_dir, f_kar)
    lead_path = cls_kar.get("vocals") or raw_vocals
    chorus_path = cls_kar.get("instrumental")

    # Pass 3 (optional): Drums / Bass / Other Instruments (HTDemucs v4)
    drums_path = None
    bass_path = None
    other_path = None
    if split_instruments:
        inst_dir = os.path.join(out_dir, "inst_sub")
        s_dem = get_separator(separator_cache, model_dir, inst_dir, DEMUCS_MODEL)
        f_dem = s_dem.separate(inst_path)
        cls_dem = classify_outputs(inst_dir, f_dem)
        drums_path = cls_dem.get("drums")
        bass_path = cls_dem.get("bass")
        other_path = cls_dem.get("other")

    style_profile = analyze_style_from_paths(inst_path, drums_path, bass_path, other_path)
    t_done = time.time()
    try:
        dur_sec = round(float(sf.info(input_path).duration), 2)
    except Exception:
        dur_sec = None

    return {
        "ok": True,
        "mode": "multistem",
        "model": "BS-RoFormer + Karaoke RoFormer + HTDemucs",
        "durationSec": dur_sec,
        "leadVocalPath": lead_path,
        "chorusPath": chorus_path,
        "vocalsPath": raw_vocals,
        "instrumentalPath": inst_path,
        "drumsPath": drums_path,
        "bassPath": bass_path,
        "otherPath": other_path,
        "rmsStats": {
            "orig": compute_rms(input_path),
            "leadVocal": compute_rms(lead_path),
            "chorus": compute_rms(chorus_path),
            "vocals": compute_rms(raw_vocals),
            "instruments": compute_rms(inst_path),
            "drums": compute_rms(drums_path) if drums_path else 0.0,
            "bass": compute_rms(bass_path) if bass_path else 0.0,
            "other": compute_rms(other_path) if other_path else 0.0,
        },
        "styleProfile": style_profile,
        "loadSec": round(t_ready - t0, 2),
        "separateSec": round(t_done - t_ready, 2),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true", help="Run persistent JSON-lines stdio server")
    parser.add_argument("--model-dir", default="models-cache")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--mode", default="2stem", choices=["2stem", "multistem", "analyze_style"])
    parser.add_argument("--input")
    parser.add_argument("--out-dir")
    args = parser.parse_args()

    proto_out = sys.stdout
    sys.stdout = sys.stderr

    separator_cache: dict = {"models": {}}

    if not args.serve:
        if args.mode == "analyze_style":
            res = {"ok": True, "styleProfile": analyze_style_from_paths(args.input)}
        elif args.mode == "multistem":
            res = run_multistem_job(separator_cache, args.model_dir, args.input, args.out_dir)
        else:
            res = run_2stem_job(separator_cache, args.model_dir, args.input, args.out_dir, args.model)
        proto_out.write(json.dumps(res) + "\n")
        proto_out.flush()
        return

    proto_out.write(json.dumps({"ready": True, "defaultModel": args.model}) + "\n")
    proto_out.flush()

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        req_id = None
        try:
            req = json.loads(raw)
            req_id = req.get("id")
            action = req.get("action") or "separate"

            if action == "preload":
                model_name = req.get("model") or args.model
                get_separator(separator_cache, args.model_dir, args.model_dir, model_name)
                proto_out.write(json.dumps({"id": req_id, "ok": True, "preloaded": model_name}) + "\n")
                proto_out.flush()
                continue

            if action == "analyze_style":
                sp = analyze_style_from_paths(
                    req["input"],
                    req.get("drumsPath"),
                    req.get("bassPath"),
                    req.get("otherPath"),
                )
                proto_out.write(json.dumps({"id": req_id, "ok": True, "styleProfile": sp}) + "\n")
                proto_out.flush()
                continue

            if action == "separate_multistem":
                split_inst = req.get("splitInstruments", True)
                res = run_multistem_job(
                    separator_cache,
                    args.model_dir,
                    req["input"],
                    req["outDir"],
                    split_instruments=bool(split_inst),
                )
            else:
                model_name = req.get("model") or args.model
                res = run_2stem_job(separator_cache, args.model_dir, req["input"], req["outDir"], model_name)

            res["id"] = req_id
            proto_out.write(json.dumps(res) + "\n")
            proto_out.flush()
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            proto_out.write(json.dumps({"id": req_id, "ok": False, "error": str(exc)}) + "\n")
            proto_out.flush()


if __name__ == "__main__":
    main()
