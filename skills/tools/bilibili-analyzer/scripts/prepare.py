#!/usr/bin/env python3
"""
Bilibili Video Downloader and Frame Extractor
下载B站视频并拆解成帧图片
"""

import os
import sys
import subprocess
import argparse


def download_video(url: str, output_path: str = "video.mp4") -> bool:
    """下载B站视频

    Args:
        url: B站视频URL
        output_path: 输出文件路径

    Returns:
        是否下载成功
    """
    print(f"[INFO] 正在下载视频: {url}")

    cmd = [
        "yt-dlp",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "-o", output_path,
        url
    ]

    try:
        result = subprocess.run(cmd, check=True)
        print(f"[OK] 视频下载完成: {output_path}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] 下载失败: {e}")
        return False
    except FileNotFoundError:
        print("[ERROR] yt-dlp 未安装，请运行: pip install yt-dlp")
        return False


def extract_frames(video_path: str, output_dir: str = "./images", fps: float = 1.0) -> bool:
    """从视频提取帧图片

    Args:
        video_path: 视频文件路径
        output_dir: 输出目录
        fps: 每秒提取帧数，默认1帧/秒

    Returns:
        是否提取成功
    """
    print(f"[INFO] 正在提取帧图片 (fps={fps})")

    # 创建输出目录
    os.makedirs(output_dir, exist_ok=True)

    output_pattern = os.path.join(output_dir, "frame_%04d.jpg")

    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-vf", f"fps={fps}",
        "-q:v", "2",
        output_pattern
    ]

    try:
        result = subprocess.run(cmd, check=True, capture_output=True)

        # 统计生成的图片数量
        frame_count = len([f for f in os.listdir(output_dir) if f.startswith("frame_") and f.endswith(".jpg")])
        print(f"[OK] 帧提取完成: {frame_count} 张图片保存到 {output_dir}/")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] 帧提取失败: {e.stderr.decode() if e.stderr else e}")
        return False
    except FileNotFoundError:
        print("[ERROR] ffmpeg 未安装，请安装 ffmpeg")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="下载B站视频并拆解成帧图片",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python prepare.py "https://www.bilibili.com/video/BV1xx411c7mD"
  python prepare.py "https://www.bilibili.com/video/BV1xx411c7mD" --fps 0.5
  python prepare.py "https://www.bilibili.com/video/BV1xx411c7mD" -o ./output
        """
    )

    parser.add_argument("url", help="B站视频URL")
    parser.add_argument("-o", "--output", default=".", help="输出目录，默认当前目录")
    parser.add_argument("--fps", type=float, default=1.0, help="每秒提取帧数，默认1")
    parser.add_argument("--video-only", action="store_true", help="只下载视频，不提取帧")
    parser.add_argument("--frames-only", action="store_true", help="只提取帧（需要已有video.mp4）")

    args = parser.parse_args()

    # 设置路径
    output_dir = args.output
    video_path = os.path.join(output_dir, "video.mp4")
    images_dir = os.path.join(output_dir, "images")

    # 创建输出目录
    os.makedirs(output_dir, exist_ok=True)

    # 下载视频
    if not args.frames_only:
        if not download_video(args.url, video_path):
            sys.exit(1)

    # 提取帧
    if not args.video_only:
        if not os.path.exists(video_path):
            print(f"[ERROR] 视频文件不存在: {video_path}")
            sys.exit(1)

        if not extract_frames(video_path, images_dir, args.fps):
            sys.exit(1)

    print("\n[OK] 完成!")
    print(f"    视频: {video_path}")
    print(f"    图片: {images_dir}/")


if __name__ == "__main__":
    main()
