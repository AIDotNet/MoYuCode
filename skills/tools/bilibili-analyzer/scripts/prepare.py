#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bilibili Video Downloader and Frame Extractor
Download Bilibili videos and extract frames
"""

import os
import sys
import subprocess
import argparse
import shutil

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


def find_yt_dlp():
    """Find yt-dlp executable or module

    Returns:
        list: Command to run yt-dlp, or None if not found
    """
    # Try direct command first
    if shutil.which("yt-dlp"):
        return ["yt-dlp"]

    # Try as Python module
    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "--version"],
            capture_output=True,
            timeout=10
        )
        if result.returncode == 0:
            return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        pass

    return None


def find_ffmpeg():
    """Find ffmpeg executable

    Returns:
        str: Path to ffmpeg, or None if not found
    """
    if shutil.which("ffmpeg"):
        return "ffmpeg"

    # Common Windows paths
    common_paths = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\tools\ffmpeg\bin\ffmpeg.exe",
    ]
    for path in common_paths:
        if os.path.exists(path):
            return path

    return None


def download_video(url: str, output_path: str = "video.mp4") -> bool:
    """Download Bilibili video

    Args:
        url: Bilibili video URL
        output_path: Output file path

    Returns:
        Whether download succeeded
    """
    print(f"[INFO] Downloading video: {url}")

    yt_dlp_cmd = find_yt_dlp()
    if not yt_dlp_cmd:
        print("[ERROR] yt-dlp not found!")
        print("        Install with: pip install yt-dlp")
        print(f"        Current Python: {sys.executable}")
        return False

    cmd = yt_dlp_cmd + [
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "-o", output_path,
        "--no-warnings",
        url
    ]

    try:
        print(f"[INFO] Running: {' '.join(cmd[:3])}...")
        result = subprocess.run(cmd, check=True)
        print(f"[OK] Video downloaded: {output_path}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Download failed: {e}")
        return False
    except Exception as e:
        print(f"[ERROR] Unexpected error: {e}")
        return False


def extract_frames(video_path: str, output_dir: str = "./images", fps: float = 1.0) -> bool:
    """Extract frames from video

    Args:
        video_path: Video file path
        output_dir: Output directory
        fps: Frames per second, default 1

    Returns:
        Whether extraction succeeded
    """
    print(f"[INFO] Extracting frames (fps={fps})")

    ffmpeg_cmd = find_ffmpeg()
    if not ffmpeg_cmd:
        print("[ERROR] ffmpeg not found!")
        print("        Windows: choco install ffmpeg / scoop install ffmpeg")
        print("        macOS: brew install ffmpeg")
        print("        Linux: sudo apt install ffmpeg")
        return False

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    output_pattern = os.path.join(output_dir, "frame_%04d.jpg")

    cmd = [
        ffmpeg_cmd,
        "-i", video_path,
        "-vf", f"fps={fps}",
        "-q:v", "2",
        "-y",  # Overwrite existing files
        output_pattern
    ]

    try:
        print(f"[INFO] Running ffmpeg...")
        result = subprocess.run(cmd, check=True, capture_output=True)

        # Count generated images
        frame_count = len([f for f in os.listdir(output_dir) if f.startswith("frame_") and f.endswith(".jpg")])
        print(f"[OK] Frames extracted: {frame_count} images saved to {output_dir}/")
        return True
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode('utf-8', errors='replace') if e.stderr else str(e)
        print(f"[ERROR] Frame extraction failed: {stderr}")
        return False
    except Exception as e:
        print(f"[ERROR] Unexpected error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Download Bilibili video and extract frames",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python prepare.py "https://www.bilibili.com/video/BV1xx411c7mD"
  python prepare.py "https://www.bilibili.com/video/BV1xx411c7mD" --fps 0.5
  python prepare.py "https://www.bilibili.com/video/BV1xx411c7mD" -o ./output
        """
    )

    parser.add_argument("url", help="Bilibili video URL")
    parser.add_argument("-o", "--output", default=".", help="Output directory (default: current)")
    parser.add_argument("--fps", type=float, default=1.0, help="Frames per second (default: 1)")
    parser.add_argument("--video-only", action="store_true", help="Only download video, skip frame extraction")
    parser.add_argument("--frames-only", action="store_true", help="Only extract frames (requires existing video.mp4)")

    args = parser.parse_args()

    # Set paths
    output_dir = args.output
    video_path = os.path.join(output_dir, "video.mp4")
    images_dir = os.path.join(output_dir, "images")

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    print("=" * 50)
    print("Bilibili Video Analyzer - Prepare Script")
    print("=" * 50)
    print(f"URL: {args.url}")
    print(f"Output: {output_dir}")
    print(f"FPS: {args.fps}")
    print("=" * 50)

    # Download video
    if not args.frames_only:
        if not download_video(args.url, video_path):
            sys.exit(1)

    # Extract frames
    if not args.video_only:
        if not os.path.exists(video_path):
            print(f"[ERROR] Video file not found: {video_path}")
            sys.exit(1)

        if not extract_frames(video_path, images_dir, args.fps):
            sys.exit(1)

    print("")
    print("=" * 50)
    print("[OK] Done!")
    print(f"  Video: {video_path}")
    print(f"  Images: {images_dir}/")
    print("=" * 50)


if __name__ == "__main__":
    main()
