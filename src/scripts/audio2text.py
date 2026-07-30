#!/usr/bin/env python3
"""
音频转文本 — Whisper large-v3 (本地GPU) + GLM-5.1 润色
集成到 mediakit 的版本，支持 --json 输出。
"""

import os
import sys
import json
import time
import urllib.request
import argparse
from pathlib import Path

CONFIG = {
    "whisper_model": "large-v3",
    "whisper_language": "zh",
    "api_key": "6502c601e108492f94cf24c242b37488.NCkR734CGapJTCPM",
    "api_base": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    "llm_model": "glm-5.1",
}


def transcribe(audio_path, model_name="large-v3", language=None):
    """Whisper 转写"""
    import whisper
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[ASR] Loading Whisper {model_name} ({device})...", file=sys.stderr)
    t0 = time.time()
    model = whisper.load_model(model_name, device=device)
    print(f"[ASR] Model loaded ({time.time()-t0:.1f}s)", file=sys.stderr)

    print(f"[ASR] Transcribing: {audio_path}", file=sys.stderr)
    t0 = time.time()
    result = model.transcribe(audio_path, language=language, fp16=(device == "cuda"))
    elapsed = time.time() - t0

    raw_text = result["text"].strip()
    segments = [
        {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
        for s in result["segments"]
    ]
    lang = result.get("language", "?")
    print(f"[ASR] Done ({elapsed:.1f}s, lang={lang}, {len(raw_text)} chars)", file=sys.stderr)
    return raw_text, segments, lang


def polish_text(raw_text, lang="zh"):
    """GLM-5.1 润色纠错"""
    proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    handler = urllib.request.ProxyHandler({"https": proxy}) if proxy else urllib.request.HTTPSHandler()
    opener = urllib.request.build_opener(handler)

    prompt = (
        "你是一个专业的文字编辑。请对以下语音转写文本进行润色和纠错，要求：\n"
        "1. 修正错别字、语法错误、标点符号\n"
        "2. 去除口语化的重复词和口头禅（如'嗯''那个''就是说'）\n"
        "3. 修正因语音识别产生的同音字错误\n"
        "4. 合理分段，添加标点\n"
        "5. 保持原意，不要随意增删内容\n\n"
        "直接输出润色后的文本，不要解释修改内容。"
    )

    payload = json.dumps({
        "model": CONFIG["llm_model"],
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": raw_text},
        ],
        "temperature": 0.3,
    }).encode("utf-8")

    req = urllib.request.Request(
        CONFIG["api_base"],
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {CONFIG['api_key']}",
        },
    )

    print("[LLM] Polishing...", file=sys.stderr)
    t0 = time.time()
    resp = opener.open(req, timeout=120)
    data = json.loads(resp.read().decode("utf-8"))
    polished = data["choices"][0]["message"]["content"].strip()
    print(f"[LLM] Done ({time.time()-t0:.1f}s)", file=sys.stderr)
    return polished


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="Audio/video file path")
    parser.add_argument("--model", default=CONFIG["whisper_model"])
    parser.add_argument("--lang", default=None)
    parser.add_argument("--no-polish", action="store_true")
    parser.add_argument("--polish", action="store_true", help="Enable GLM polish")
    parser.add_argument("--json", action="store_true", help="Output as JSON to stdout")
    parser.add_argument("--output-dir", default=None)
    args = parser.parse_args()

    audio_path = os.path.abspath(args.audio)
    if not os.path.exists(audio_path):
        if args.json:
            print(json.dumps({"ok": False, "error": f"File not found: {audio_path}"}))
        else:
            print(f"File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    out_dir = args.output_dir or str(Path(audio_path).parent)
    os.makedirs(out_dir, exist_ok=True)
    stem = Path(audio_path).stem

    # Transcribe
    raw_text, segments, lang = transcribe(audio_path, args.model, args.lang or CONFIG["whisper_language"])

    # Polish (off by default, on with --polish)
    polished = raw_text
    if args.polish and not args.no_polish:
        polished = polish_text(raw_text, lang)

    # Save files
    raw_path = os.path.join(out_dir, f"{stem}_raw.txt")
    with open(raw_path, "w", encoding="utf-8") as f:
        f.write(raw_text)

    final_path = os.path.join(out_dir, f"{stem}_transcript.txt")
    with open(final_path, "w", encoding="utf-8") as f:
        f.write(polished)

    # JSON output for mediakit
    if args.json:
        print(json.dumps({
            "ok": True,
            "text": polished,
            "raw_text": raw_text,
            "lang": lang,
            "segments_count": len(segments),
            "transcript_path": final_path,
        }, ensure_ascii=False))
    else:
        print(f"\nTranscript → {final_path}")
        if polished != raw_text:
            print(f"Raw       → {raw_path}")


if __name__ == "__main__":
    main()
