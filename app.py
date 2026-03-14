import eel
import yt_dlp
import os
import threading
import re
import urllib.request
import json
import time
from pathlib import Path

eel.init('web')

DOWNLOAD_DIR = str(Path.home() / "Downloads" / "MediaDownloader")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

active_downloads = {}   # download_id -> cancel_event
pause_events    = {}    # download_id -> pause_event (threading.Event — set = paused)


# ─── HELPERS ──────────────────────────────────────────────

def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name)

def format_speed(speed):
    if not speed:
        return '0 B/s'
    for unit in ['B/s', 'KB/s', 'MB/s', 'GB/s']:
        if speed < 1024:
            return f'{speed:.1f} {unit}'
        speed /= 1024
    return f'{speed:.1f} GB/s'

def format_eta(eta):
    if not eta:
        return ''
    if eta < 60:
        return f'{int(eta)}s'
    elif eta < 3600:
        return f'{int(eta)//60}m {int(eta)%60}s'
    else:
        return f'{int(eta)//3600}h {(int(eta)%3600)//60}m'

def format_size(size):
    if not size:
        return '?'
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024:
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} GB'

def format_duration(seconds):
    if not seconds:
        return '0:00'
    h = int(seconds) // 3600
    m = (int(seconds) % 3600) // 60
    s = int(seconds) % 60
    if h:
        return f'{h}:{m:02d}:{s:02d}'
    return f'{m}:{s:02d}'

def detect_platform(url):
    u = url.lower()
    if 'youtube.com' in u or 'youtu.be' in u:
        return 'YouTube'
    elif 'tiktok.com' in u:
        return 'TikTok'
    elif 'instagram.com' in u:
        return 'Instagram'
    elif 'twitter.com' in u or 'x.com' in u:
        return 'Twitter/X'
    elif 'vimeo.com' in u:
        return 'Vimeo'
    elif 'twitch.tv' in u:
        return 'Twitch'
    elif 'dailymotion.com' in u:
        return 'Dailymotion'
    elif 'soundcloud.com' in u:
        return 'SoundCloud'
    elif 'reddit.com' in u:
        return 'Reddit'
    else:
        return 'Web'

def build_base_opts(proxy=None):
    opts = {'quiet': True, 'no_warnings': True}
    if proxy:
        opts['proxy'] = proxy
    return opts


# ─── PROGRESS HOOK (with pause support) ────────────────────

class DownloadProgress:
    def __init__(self, download_id, cancel_event, pause_event, pl_index=None, pl_total=None):
        self.download_id  = download_id
        self.cancel_event = cancel_event
        self.pause_event  = pause_event
        self.last_percent = -1
        self.pl_index     = pl_index
        self.pl_total     = pl_total

    def hook(self, d):
        # Cancel check
        if self.cancel_event.is_set():
            raise yt_dlp.utils.DownloadCancelled()

        # Pause: spin-wait until unpaused or cancelled
        while self.pause_event.is_set():
            if self.cancel_event.is_set():
                raise yt_dlp.utils.DownloadCancelled()
            time.sleep(0.25)

        if d['status'] == 'downloading':
            total      = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
            downloaded = d.get('downloaded_bytes', 0)
            speed      = d.get('speed', 0) or 0
            eta        = d.get('eta', 0) or 0
            percent    = int((downloaded / total * 100) if total > 0 else 0)
            if percent != self.last_percent:
                self.last_percent = percent
                try:
                    eel.update_progress(
                        self.download_id, percent,
                        format_speed(speed), format_eta(eta),
                        d.get('filename', '').split(os.sep)[-1],
                        self.pl_index, self.pl_total
                    )()
                except Exception:
                    pass
        elif d['status'] == 'finished':
            try:
                eel.update_progress(
                    self.download_id, 100, '', '',
                    d.get('filename', '').split(os.sep)[-1],
                    self.pl_index, self.pl_total
                )()
            except Exception:
                pass


# ─── INFO ──────────────────────────────────────────────────

def _fmt_views(v):
    if not v: return ''
    if v >= 1_000_000: return f'{v/1_000_000:.1f}M просмотров'
    if v >= 1_000:     return f'{v/1_000:.1f}K просмотров'
    return f'{v} просмотров'

def _fmt_date(d):
    if not d or len(d) != 8: return ''
    return f'{d[6:8]}.{d[4:6]}.{d[:4]}'

def _all_thumbnails(info):
    thumbs = info.get('thumbnails') or []
    result = []
    seen   = set()
    for t in reversed(thumbs):
        url = t.get('url', '')
        if url and url not in seen:
            seen.add(url)
            result.append({'url': url, 'width': t.get('width', 0), 'height': t.get('height', 0)})
        if len(result) >= 8:
            break
    return result

def _default_formats():
    return [
        {'format_id': 'bestvideo+bestaudio/best', 'quality': 'Best', 'ext': 'mp4',
         'size': 'Auto', 'fps': '', 'vcodec': '', 'type': 'video', 'filesize_approx': 0},
        {'format_id': 'worst', 'quality': 'Lowest', 'ext': 'mp4',
         'size': 'Auto', 'fps': '', 'vcodec': '', 'type': 'video', 'filesize_approx': 0},
    ]

def _video_formats(info):
    formats = []
    seen    = set()

    for f in (info.get('formats') or []):
        vcodec = f.get('vcodec', 'none')
        acodec = f.get('acodec', 'none')
        if vcodec != 'none' and acodec != 'none':
            height = f.get('height')
            ext    = f.get('ext', 'mp4')
            fps    = f.get('fps') or 0
            key    = (height, ext)
            if height and key not in seen:
                seen.add(key)
                size_bytes = f.get('filesize') or f.get('filesize_approx', 0)
                formats.append({
                    'format_id':       f['format_id'],
                    'quality':         f'{height}p',
                    'ext':             ext,
                    'size':            format_size(size_bytes) if size_bytes else '?',
                    'fps':             str(int(fps)) if fps else '',
                    'vcodec':          vcodec.split('.')[0],
                    'type':            'video',
                    'filesize_approx': size_bytes or 0,
                })

    # High-res video-only + bestaudio
    for f in (info.get('formats') or []):
        vcodec = f.get('vcodec', 'none')
        acodec = f.get('acodec', 'none')
        if vcodec != 'none' and acodec == 'none':
            height = f.get('height')
            fps    = f.get('fps') or 0
            key    = (height, 'sep')
            if height and height >= 1440 and key not in seen:
                seen.add(key)
                size_bytes = f.get('filesize') or f.get('filesize_approx', 0)
                formats.append({
                    'format_id':       f'{f["format_id"]}+bestaudio',
                    'quality':         f'{height}p',
                    'ext':             'mp4',
                    'size':            format_size(size_bytes) if size_bytes else '?',
                    'fps':             str(int(fps)) if fps else '',
                    'vcodec':          vcodec.split('.')[0],
                    'type':            'video',
                    'filesize_approx': size_bytes or 0,
                })

    formats.sort(
        key=lambda x: int(x['quality'].replace('p', '')) if x['quality'].endswith('p') else 0,
        reverse=True
    )

    final    = []
    seen_q   = set()
    for f in formats:
        if f['quality'] not in seen_q:
            seen_q.add(f['quality'])
            final.append(f)

    return final[:10] if final else _default_formats()


@eel.expose
def get_video_info(url, proxy=None):
    try:
        opts = build_base_opts(proxy)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)

        is_playlist = info.get('_type') == 'playlist' or bool(info.get('entries'))

        if is_playlist:
            entries = [e for e in (info.get('entries') or []) if e]
            items   = []
            for e in entries[:100]:
                items.append({
                    'title':     e.get('title', 'Unknown'),
                    'duration':  format_duration(e.get('duration', 0)),
                    'thumbnail': e.get('thumbnail', ''),
                    'url':       e.get('webpage_url') or e.get('url', ''),
                })
            return {
                'success':        True,
                'is_playlist':    True,
                'playlist_title': info.get('title', 'Playlist'),
                'playlist_count': info.get('playlist_count') or len(entries),
                'uploader':       info.get('uploader', 'Unknown'),
                'platform':       detect_platform(url),
                'thumbnail':      entries[0].get('thumbnail', '') if entries else '',
                'items':          items,
                'formats':        _default_formats(),
            }

        # Estimate total filesize from best format
        filesize_approx = 0
        for f in reversed(info.get('formats') or []):
            sz = f.get('filesize') or f.get('filesize_approx', 0)
            if sz:
                filesize_approx = sz
                break

        return {
            'success':          True,
            'is_playlist':      False,
            'title':            info.get('title', 'Unknown'),
            'thumbnail':        info.get('thumbnail', ''),
            'duration':         format_duration(info.get('duration', 0)),
            'uploader':         info.get('uploader', 'Unknown'),
            'platform':         detect_platform(url),
            'view_count':       _fmt_views(info.get('view_count')),
            'upload_date':      _fmt_date(info.get('upload_date')),
            'formats':          _video_formats(info),
            'thumbnails':       _all_thumbnails(info),
            'filesize_approx':  filesize_approx,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── DOWNLOAD ──────────────────────────────────────────────

@eel.expose
def start_download(download_id, url, options):
    def run():
        try:
            opt = options if isinstance(options, dict) else json.loads(options)
            save_dir = opt.get('output_path') or DOWNLOAD_DIR
            os.makedirs(save_dir, exist_ok=True)

            cancel_event = threading.Event()
            pause_event  = threading.Event()   # set = paused
            active_downloads[download_id] = cancel_event
            pause_events[download_id]     = pause_event

            proxy        = opt.get('proxy') or None
            audio_only   = opt.get('audio_only', False)
            audio_format = opt.get('audio_format', 'mp3')
            video_ext    = opt.get('video_format', 'mp4')
            dl_thumb     = opt.get('download_thumbnail', False)
            subtitles    = opt.get('subtitles', False)
            is_playlist  = opt.get('is_playlist', False)
            pl_start     = int(opt.get('playlist_start') or 1)
            pl_end       = opt.get('playlist_end')
            resume       = opt.get('resume', False)

            # Custom filename
            custom_name  = opt.get('custom_filename') or None

            # Metadata options
            embed_meta   = opt.get('embed_metadata', False)
            meta_title   = opt.get('meta_title', '')
            meta_artist  = opt.get('meta_artist', '')
            meta_year    = opt.get('meta_year', '')
            meta_thumb   = opt.get('meta_thumb', '')

            progress = DownloadProgress(download_id, cancel_event, pause_event)
            base     = build_base_opts(proxy)
            base['progress_hooks'] = [progress.hook]

            # Resume / continue partial downloads
            if resume:
                base['continuedl'] = True

            # Output template
            if is_playlist:
                base['outtmpl']       = os.path.join(save_dir, '%(playlist_title)s', '%(playlist_index)02d - %(title)s.%(ext)s')
                base['playliststart'] = pl_start
                if pl_end:
                    base['playlistend'] = int(pl_end)
            elif custom_name:
                safe_name        = sanitize_filename(custom_name)
                base['outtmpl']  = os.path.join(save_dir, f'{safe_name}.%(ext)s')
            else:
                base['outtmpl']  = os.path.join(save_dir, '%(title)s.%(ext)s')

            postprocessors = []

            if audio_only:
                codec_map = {
                    'mp3':  ('mp3',  '192'),
                    'aac':  ('aac',  '192'),
                    'flac': ('flac', '0'),
                    'wav':  ('wav',  '0'),
                    'opus': ('opus', '128'),
                    'm4a':  ('m4a',  '192'),
                }
                codec, quality = codec_map.get(audio_format, ('mp3', '192'))
                postprocessors.append({
                    'key':              'FFmpegExtractAudio',
                    'preferredcodec':   codec,
                    'preferredquality': quality,
                })

                # Embed ID3 metadata for audio
                if embed_meta:
                    # FFmpegMetadata PP writes tags from info_dict,
                    # but we can override via 'add_metadata' key
                    postprocessors.append({'key': 'FFmpegMetadata', 'add_metadata': True})
                    # Inject custom tags via modify_chapters / postprocessor_args
                    if meta_title:  base.setdefault('postprocessor_args', {})['FFmpegMetadata'] = []
                    # Use yt-dlp's built-in metadata override via --parse-metadata
                    if meta_title:
                        base.setdefault('parse_metadata', []).append(f':{meta_title}:%(title)s')
                    # The cleanest way: pass overrides through yt-dlp metadata syntax
                    meta_overrides = {}
                    if meta_title:  meta_overrides['title']  = meta_title
                    if meta_artist: meta_overrides['artist'] = meta_artist
                    if meta_year:   meta_overrides['year']   = meta_year
                    if meta_overrides:
                        base['add_metadata'] = True
                        # Inject via replace_in_metadata or postprocessor_args
                        for key, val in meta_overrides.items():
                            base.setdefault('postprocessor_args', {}).setdefault('FFmpegMetadata', []).extend(
                                ['-metadata', f'{key}={val}']
                            )
                    # Embed thumbnail in audio (cover art)
                    if meta_thumb and (audio_format in ('mp3', 'm4a', 'aac')):
                        postprocessors.append({'key': 'EmbedThumbnail'})
                        base['writethumbnail'] = True

                ydl_opts = {**base, 'format': 'bestaudio/best', 'postprocessors': postprocessors}

            else:
                fmt_id     = opt.get('format_id') or 'bestvideo+bestaudio/best'
                merge_fmt  = video_ext if video_ext in ('mp4', 'mkv', 'webm') else 'mp4'

                if dl_thumb:
                    base['writethumbnail'] = True
                    postprocessors.append({'key': 'FFmpegThumbnailsConvertor', 'format': 'jpg'})

                if subtitles:
                    base['writesubtitles']    = True
                    base['writeautomaticsub'] = True
                    base['subtitleslangs']    = ['ru', 'en']
                    postprocessors.append({'key': 'FFmpegEmbedSubtitle'})

                # Embed metadata into video
                if embed_meta:
                    postprocessors.append({'key': 'FFmpegMetadata', 'add_metadata': True})
                    meta_overrides = {}
                    if meta_title:  meta_overrides['title']       = meta_title
                    if meta_artist: meta_overrides['artist']      = meta_artist
                    if meta_year:   meta_overrides['date']        = meta_year
                    if meta_overrides:
                        base['add_metadata'] = True
                        for key, val in meta_overrides.items():
                            base.setdefault('postprocessor_args', {}).setdefault('FFmpegMetadata', []).extend(
                                ['-metadata', f'{key}={val}']
                            )

                ydl_opts = {
                    **base,
                    'format':               fmt_id,
                    'merge_output_format':  merge_fmt,
                    'postprocessors':       postprocessors,
                }

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            if not cancel_event.is_set():
                eel.download_complete(download_id, 'success', save_dir)()

        except yt_dlp.utils.DownloadCancelled:
            try:
                eel.download_complete(download_id, 'cancelled', '')()
            except Exception:
                pass
        except Exception as e:
            try:
                eel.download_complete(download_id, 'error', str(e))()
            except Exception:
                pass
        finally:
            active_downloads.pop(download_id, None)
            pause_events.pop(download_id, None)

    threading.Thread(target=run, daemon=True).start()
    return {'success': True}


# ─── PAUSE / RESUME ────────────────────────────────────────

@eel.expose
def pause_download(download_id):
    """Pause an active download (blocks progress hook loop)."""
    ev = pause_events.get(download_id)
    if ev:
        ev.set()   # set = paused
    return {'success': True}

@eel.expose
def resume_download(download_id):
    """Resume a paused download."""
    ev = pause_events.get(download_id)
    if ev:
        ev.clear()  # clear = running
    return {'success': True}


# ─── CANCEL ────────────────────────────────────────────────

@eel.expose
def cancel_download(download_id):
    event = active_downloads.get(download_id)
    if event:
        event.set()
    # Also unblock pause so cancel is noticed immediately
    p_ev = pause_events.get(download_id)
    if p_ev:
        p_ev.clear()
    return {'success': True}


# ─── THUMBNAIL ─────────────────────────────────────────────

@eel.expose
def download_thumbnail_only(download_id, thumb_url, title, output_path):
    def run():
        try:
            save_dir     = output_path or DOWNLOAD_DIR
            os.makedirs(save_dir, exist_ok=True)
            cancel_event = threading.Event()
            pause_event  = threading.Event()
            active_downloads[download_id] = cancel_event
            pause_events[download_id]     = pause_event

            filename = os.path.join(save_dir, f'{sanitize_filename(title)}.jpg')
            eel.update_progress(download_id, 0, '', '', 'Загрузка превью...', None, None)()
            req = urllib.request.Request(thumb_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
            with open(filename, 'wb') as f:
                f.write(data)
            eel.update_progress(download_id, 100, '', '', os.path.basename(filename), None, None)()
            eel.download_complete(download_id, 'success', save_dir)()
        except Exception as e:
            try:
                eel.download_complete(download_id, 'error', str(e))()
            except Exception:
                pass
        finally:
            active_downloads.pop(download_id, None)
            pause_events.pop(download_id, None)

    threading.Thread(target=run, daemon=True).start()
    return {'success': True}


# ─── MISC ──────────────────────────────────────────────────

@eel.expose
def choose_folder():
    """Open native folder picker dialog, return chosen path or empty string."""
    import sys
    import subprocess
    try:
        if sys.platform == 'win32':
            # Use PowerShell FolderBrowserDialog
            ps_script = (
                'Add-Type -AssemblyName System.Windows.Forms;'
                '$d = New-Object System.Windows.Forms.FolderBrowserDialog;'
                '$d.Description = "Выберите папку для сохранения";'
                '$d.ShowNewFolderButton = $true;'
                'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }'
            )
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_script],
                capture_output=True, text=True, timeout=60
            )
            path = result.stdout.strip()
            return path if path else ''
        elif sys.platform == 'darwin':
            result = subprocess.run(
                ['osascript', '-e',
                 'set f to POSIX path of (choose folder with prompt "Выберите папку для сохранения")'],
                capture_output=True, text=True, timeout=60
            )
            path = result.stdout.strip()
            return path if path else ''
        else:
            # Linux: try zenity, then kdialog, then yad
            for cmd in [
                ['zenity', '--file-selection', '--directory',
                 '--title=Выберите папку для сохранения'],
                ['kdialog', '--getexistingdirectory', os.path.expanduser('~')],
                ['yad', '--file', '--directory',
                 '--title=Выберите папку для сохранения'],
            ]:
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                    path = result.stdout.strip()
                    if path:
                        return path
                except FileNotFoundError:
                    continue
            return ''
    except Exception as e:
        return ''

@eel.expose
def get_default_path():
    return DOWNLOAD_DIR

@eel.expose
def set_default_path(path):
    global DOWNLOAD_DIR
    if path and os.path.isdir(path):
        DOWNLOAD_DIR = path
        return True
    return False

@eel.expose
def open_folder(path):
    import subprocess, sys
    try:
        if sys.platform == 'win32':
            os.startfile(path)
        elif sys.platform == 'darwin':
            subprocess.run(['open', path])
        else:
            subprocess.run(['xdg-open', path])
        return True
    except Exception:
        return False

@eel.expose
def test_proxy(proxy):
    try:
        proxy_handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
        opener        = urllib.request.build_opener(proxy_handler)
        opener.open('https://www.youtube.com', timeout=8)
        return {'success': True}
    except Exception as e:
        return {'success': False, 'error': str(e)}

@eel.expose
def get_ydlp_version():
    return yt_dlp.version.__version__


if __name__ == '__main__':
    eel.start('index.html', size=(1120, 800), port=8888)