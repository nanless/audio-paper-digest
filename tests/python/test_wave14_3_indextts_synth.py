#!/usr/bin/env python3
"""Wave 14.3 Python tests for scripts/indextts_synth.py (IndexTTS-2.5 / 2.0 / HTTP / silent-mock)."""

from __future__ import annotations

import base64
import io
import json
import math
import os
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import types
import unittest
import wave
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / 'scripts'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import indextts_synth as synth  # noqa: E402


def make_sample_script() -> dict:
    return {
        'contract': 'daily-podcast-script',
        'date': '2026-11-24',
        'title': '语音/音频论文速递播客 2026-11-24',
        'scriptSha256': 'c' * 64,
        'segments': [
            {
                'id': 'intro',
                'kind': 'intro',
                'role': 'host',
                'title': '开场与今日脉络',
                'text': '大家好，欢迎收听今天的音频论文速递。',
                'chunks': ['大家好，欢迎收听今天的音频论文速递。'],
                'emotionHint': 'warm',
                'pauseMsAfter': 300,
            },
            {
                'id': 'highlight-1',
                'kind': 'highlight',
                'role': 'cohost',
                'title': '精选 1：StreamCodec-Pro',
                'text': '第一篇论文解决低延迟神经音频编解码问题。',
                'chunks': ['第一篇论文解决低延迟神经音频编解码问题。', '它在24千赫兹下实现了极低延迟。'],
                'emotionHint': 'enthusiastic',
                'paperId': '2611.10001v1',
                'pauseMsAfter': 400,
            },
            {
                'id': 'outro',
                'kind': 'outro',
                'role': 'host',
                'title': '结语与阅读入口',
                'text': '感谢收听，我们下期再见。',
                'chunks': ['感谢收听，我们下期再见。'],
                'emotionHint': 'closing',
                'pauseMsAfter': 200,
            },
        ],
    }


def make_tone_wav_bytes(
    duration_sec: float = 0.25,
    sample_rate: int = 44100,
    freq_hz: float = 440.0,
    channels: int = 1,
) -> bytes:
    nframes = max(1, int(round(duration_sec * sample_rate)))
    samples = []
    for i in range(nframes):
        val = int(1200 * math.sin(2.0 * math.pi * freq_hz * i / sample_rate))
        for _ in range(channels):
            samples.append(val)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack('<' + 'h' * len(samples), *samples))
    return buf.getvalue()


def make_float32_wav_bytes(duration_sec: float = 0.2, sample_rate: int = 24000) -> bytes:
    """Create an IEEE float32 WAV (format tag 3) that Python stdlib wave rejects with wave.Error."""
    nframes = max(1, int(round(duration_sec * sample_rate)))
    pcm = struct.pack('<' + 'f' * nframes, *[0.1 * math.sin(2.0 * math.pi * 440.0 * i / sample_rate) for i in range(nframes)])
    byte_rate = sample_rate * 4
    fmt_chunk = struct.pack('<4sIHHIIHH', b'fmt ', 16, 3, 1, sample_rate, byte_rate, 4, 32)
    data_chunk = struct.pack('<4sI', b'data', len(pcm)) + pcm
    riff = struct.pack('<4sI4s', b'RIFF', 4 + len(fmt_chunk) + len(data_chunk), b'WAVE')
    return riff + fmt_chunk + data_chunk


class FakePinnedResponse:
    def __init__(
        self,
        body: bytes = b'',
        status: int = 200,
        headers: dict | None = None,
        chunk_delay: float = 0.0,
    ):
        self._buf = io.BytesIO(body)
        self.status = status
        self._headers = {k.lower(): v for k, v in (headers or {'Content-Type': 'audio/wav'}).items()}
        self._chunk_delay = chunk_delay
        self.closed = False

    def getheader(self, name: str, default=None):
        return self._headers.get(name.lower(), default)

    def read(self, amt: int = -1) -> bytes:
        if self._chunk_delay > 0:
            time.sleep(self._chunk_delay)
        return self._buf.read(amt)

    def close(self) -> None:
        self.closed = True


class FakePinnedConnection:
    def __init__(self, *, scheme, pinned_ip, port, hostname, timeout, responder, log_list):
        self.scheme = scheme
        self.pinned_ip = pinned_ip
        self.port = port
        self.hostname = hostname
        self.timeout = timeout
        self._responder = responder
        self._log_list = log_list
        self._req = None
        self.closed = False
        self.sock = types.SimpleNamespace(settimeout=lambda _t: None)

    def request(self, method: str, target: str, body: bytes = b'', headers: dict | None = None):
        self._req = (method, target, body, dict(headers or {}))
        self._log_list.append({
            'scheme': self.scheme,
            'pinned_ip': self.pinned_ip,
            'port': self.port,
            'hostname': self.hostname,
            'method': method,
            'target': target,
            'headers': dict(headers or {}),
            'body': json.loads(body.decode('utf-8')) if body else None,
            'timeout': self.timeout,
        })

    def getresponse(self):
        return self._responder(self._req, self)

    def close(self) -> None:
        self.closed = True


class Wave143IndexTTSSynthTest(unittest.TestCase):
    def test_check_env_cli_and_version_priority(self):
        res = subprocess.run(
            ['bash', str(SCRIPTS_DIR / 'python-runtime.sh'), str(SCRIPTS_DIR / 'indextts_synth.py'), '--check-env'],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        info = json.loads(res.stdout)
        self.assertEqual(info['contract'], synth.PODCAST_AUDIO_MANIFEST_CONTRACT)
        self.assertIn(info['device'], ('cuda', 'mps', 'cpu'))
        self.assertIn(info['indexttsStatus'], ('IndexTTS2.5', 'IndexTTS2', 'IndexTTS', 'not-installed'))
        self.assertIn('IndexTTS-2.5', info['installHint'])
        self.assertIsInstance(info['ffmpegAvailable'], bool)

        class FakeV25:
            pass

        class FakeV20:
            pass

        class FakeV1:
            pass

        pkg = types.ModuleType('indextts')
        pkg.__version__ = '2.5.0'
        mod_v25 = types.ModuleType('indextts.infer_v2_5')
        mod_v25.IndexTTS2 = FakeV25
        mod_v20 = types.ModuleType('indextts.infer_v2')
        mod_v20.IndexTTS2 = FakeV20
        mod_v1 = types.ModuleType('indextts.infer')
        mod_v1.IndexTTS = FakeV1

        with mock.patch.dict(sys.modules, {
            'indextts': pkg,
            'indextts.infer_v2_5': mod_v25,
            'indextts.infer_v2': mod_v20,
            'indextts.infer': mod_v1,
        }):
            cls, status, engine, ver = synth.resolve_indextts_class()
            self.assertIs(cls, FakeV25)
            self.assertEqual(status, 'IndexTTS2.5')
            self.assertEqual(engine, 'indextts-2.5')
            self.assertEqual(ver, '2.5.0')

        with mock.patch.dict(sys.modules, {
            'indextts': pkg,
            'indextts.infer_v2_5': None,
            'indextts.infer_v2': mod_v20,
            'indextts.infer': mod_v1,
        }):
            cls, status, engine, _ = synth.resolve_indextts_class()
            self.assertIs(cls, FakeV20)
            self.assertEqual(status, 'IndexTTS2')
            self.assertEqual(engine, 'indextts-2')

        with mock.patch.dict(sys.modules, {
            'indextts': pkg,
            'indextts.infer_v2_5': None,
            'indextts.infer_v2': None,
            'indextts.infer': mod_v1,
        }):
            cls, status, engine, _ = synth.resolve_indextts_class()
            self.assertIs(cls, FakeV1)
            self.assertEqual(status, 'IndexTTS')
            self.assertEqual(engine, 'indextts-1')

        fake_torch = types.SimpleNamespace(
            __version__='2.6.0',
            cuda=types.SimpleNamespace(is_available=lambda: False),
            backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: True)),
        )
        with mock.patch.dict(sys.modules, {'torch': fake_torch}):
            tinfo = synth.detect_torch_info('auto')
            self.assertEqual(tinfo['device'], 'mps')
            self.assertTrue(tinfo['mpsAvailable'])

    def test_silent_mock_chapters_resplit_cache_poisoning_guard_and_rate_bounds(self):
        script = make_sample_script()
        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            cache_dir = tmp / 'cache'
            out_mp3 = tmp / 'podcast-2026-11-24.mp3'
            backend = synth.SilentMockBackend(seconds_per_chunk=0.25)

            # Invalid sample_rate / bitrate bounds rejected
            with self.assertRaises(ValueError):
                synth.synthesize_podcast_script(script, backend=backend, output_path=out_mp3, sample_rate=1000)
            with self.assertRaises(ValueError):
                synth.synthesize_podcast_script(script, backend=backend, output_path=out_mp3, bitrate_kbps=999)

            m1 = synth.synthesize_podcast_script(
                script, backend=backend, output_path=out_mp3, cache_dir=cache_dir, audio_format='mp3'
            )
            self.assertEqual(m1['contract'], 'daily-podcast-audio')
            self.assertEqual(m1['cacheStats'], {'hits': 0, 'misses': 4, 'totalChunks': 4})
            self.assertEqual(m1['chapters'][0]['startSec'], 0.0)
            self.assertAlmostEqual(m1['chapters'][-1]['endSec'], m1['durationSeconds'], places=3)

            # Second run hits 100% cache
            m2 = synth.synthesize_podcast_script(
                script, backend=backend, output_path=tmp / 'run2.mp3', cache_dir=cache_dir, audio_format='mp3'
            )
            self.assertEqual(m2['cacheStats'], {'hits': 4, 'misses': 0, 'totalChunks': 4})
            self.assertEqual(m1['audioSha256'], m2['audioSha256'])

            # Poison one cached WAV with stereo 22050Hz -> is_valid_wav_file MUST reject & re-synthesize!
            cached_files = sorted(cache_dir.glob('*.wav'))
            self.assertEqual(len(cached_files), 4)
            cached_files[0].write_bytes(make_tone_wav_bytes(0.25, sample_rate=22050, channels=2))
            self.assertFalse(synth.is_valid_wav_file(cached_files[0], expected_sample_rate=44100))
            m_repaired = synth.synthesize_podcast_script(
                script, backend=backend, output_path=tmp / 'repaired.mp3', cache_dir=cache_dir, audio_format='mp3'
            )
            self.assertEqual(m_repaired['cacheStats'], {'hits': 3, 'misses': 1, 'totalChunks': 4})

            # Overlong pre-split chunk (>180 chars) MUST be re-split inside Python synthesizer (Finding 7)
            overlong_script = json.loads(json.dumps(script))
            overlong_script['segments'] = [{
                'id': 'long',
                'role': 'host',
                'title': '超长片段',
                'text': '这是一段超长的测试文本，用来验证分块保护。' * 15,
                'chunks': ['这是一段超长的测试文本，用来验证分块保护。' * 15],
                'emotionHint': 'calm',
                'pauseMsAfter': 100,
            }]
            m_long = synth.synthesize_podcast_script(
                overlong_script, backend=backend, output_path=tmp / 'long.wav', cache_dir=tmp / 'c_long', audio_format='wav'
            )
            self.assertGreaterEqual(m_long['cacheStats']['totalChunks'], 2)

            # Pure-Python WAV fallback when ffmpeg is absent
            with mock.patch.object(synth.shutil, 'which', return_value=None):
                m_wav = synth.synthesize_podcast_script(
                    script, backend=backend, output_path=tmp / 'fallback.mp3', cache_dir=cache_dir, audio_format='mp3'
                )
                self.assertEqual(m_wav['format'], 'wav')
                self.assertEqual(m_wav['mimeType'], 'audio/wav')
                self.assertTrue(synth.is_valid_wav_file(Path(m_wav['audioPath']), expected_sample_rate=44100))

                # Mismatched WAV format WITHOUT ffmpeg must fail closed (NEVER silently copy!)
                bad_wav = tmp / 'stereo22k.wav'
                bad_wav.write_bytes(make_tone_wav_bytes(0.2, sample_rate=22050, channels=2))
                with self.assertRaises(synth.IndexTTSError):
                    synth.normalize_wav_format(bad_wav, tmp / 'out_fail.wav', sample_rate=44100)

            # Float32 IEEE WAV (triggers wave.Error) is transcoded cleanly via ffmpeg when available
            if shutil.which('ffmpeg'):
                f32_wav = tmp / 'float32.wav'
                f32_wav.write_bytes(make_float32_wav_bytes(0.2, sample_rate=24000))
                norm_out = tmp / 'norm_from_f32.wav'
                synth.normalize_wav_format(f32_wav, norm_out, sample_rate=44100)
                self.assertTrue(synth.is_valid_wav_file(norm_out, expected_sample_rate=44100))

    def test_loudnorm_drift_fallback_and_chapter_clamping(self):
        # Chapter alignment clamps & enforces monotonicity and exact final endSec
        clamped = synth._clamp_and_align_chapters(
            [
                {'index': 0, 'title': 'A', 'startSec': 0.0, 'endSec': 5.0, 'paperId': None},
                {'index': 1, 'title': 'B', 'startSec': 4.8, 'endSec': 12.5, 'paperId': '2611.10001v1'},
            ],
            final_duration=10.2,
        )
        self.assertEqual(clamped[0]['startSec'], 0.0)
        self.assertEqual(clamped[0]['endSec'], 5.0)
        self.assertEqual(clamped[1]['startSec'], 5.0)  # clamped monotonic >= prev_end
        self.assertEqual(clamped[1]['endSec'], 10.2)   # aligned to final_duration

        # Loudnorm drift > 1.0s triggers automatic fallback to plain libmp3lame
        if shutil.which('ffmpeg'):
            with tempfile.TemporaryDirectory() as tmp_str:
                tmp = Path(tmp_str)
                wav_path = tmp / 'tone.wav'
                wav_path.write_bytes(make_tone_wav_bytes(0.5, sample_rate=44100))
                probe_calls = {'n': 0}

                def fake_probe(_path):
                    probe_calls['n'] += 1
                    # First probe (loudnorm output) simulates 3.0s drift (> 1.0s); second probe returns exact 0.5s
                    return 3.5 if probe_calls['n'] == 1 else 0.502

                with mock.patch.object(synth, '_probe_duration_ffprobe', side_effect=fake_probe):
                    encoded = synth.encode_final_audio(
                        wav_path, tmp / 'out.mp3', requested_format='mp3', enable_loudnorm=True
                    )
                    self.assertFalse(encoded['loudnessNormalized'])
                    self.assertAlmostEqual(encoded['durationSeconds'], 0.502, places=3)
                    self.assertEqual(probe_calls['n'], 2)

    def test_indextts2_python_var_kwargs_filtering_v25_v20_v1_and_cache_identity(self):
        script = make_sample_script()
        v25_calls = []
        v1_calls = []
        tone_bytes = make_tone_wav_bytes(0.25)

        class MockIndexTTS25WithVarKwargs:
            def __init__(self, cfg_path, model_dir, use_fp16=False, use_cuda_kernel=False, **extra_init):
                self.extra_init = extra_init

            def infer(
                self,
                spk_audio_prompt,
                text,
                output_path,
                emo_vector=None,
                emo_alpha=1.0,
                use_random=False,
                lang='ZH',
                verbose=False,
                **generation_kwargs,
            ):
                # Strict guard: **generation_kwargs MUST remain empty (no extraneous keys!)
                v25_calls.append({
                    'spk_audio_prompt': spk_audio_prompt,
                    'text': text,
                    'emo_vector': emo_vector,
                    'emo_alpha': emo_alpha,
                    'use_random': use_random,
                    'lang': lang,
                    'generation_kwargs': dict(generation_kwargs),
                })
                Path(output_path).write_bytes(tone_bytes)

        class MockIndexTTS1WithVarKwargs:
            def __init__(self, model_dir, cfg_path, **extra_init):
                self.extra_init = extra_init

            def infer(self, audio_prompt, text, output_path, **generation_kwargs):
                v1_calls.append({
                    'audio_prompt': audio_prompt,
                    'text': text,
                    'generation_kwargs': dict(generation_kwargs),
                })
                Path(output_path).write_bytes(tone_bytes)

        pkg = types.ModuleType('indextts')
        pkg.__version__ = '2.5.2'
        mod_v25 = types.ModuleType('indextts.infer_v2_5')
        mod_v25.IndexTTS2 = MockIndexTTS25WithVarKwargs
        mod_v1 = types.ModuleType('indextts.infer')
        mod_v1.IndexTTS = MockIndexTTS1WithVarKwargs

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            ckpt_dir = tmp / 'checkpoints'
            ckpt_dir.mkdir()
            cfg_file = ckpt_dir / 'config.yaml'
            cfg_file.write_text('model: indextts-2.5\n', encoding='utf-8')
            host_wav = tmp / 'host_ref.wav'
            cohost_wav = tmp / 'cohost_ref.wav'
            host_wav.write_bytes(tone_bytes)
            cohost_wav.write_bytes(make_tone_wav_bytes(0.25, freq_hz=520.0))

            with mock.patch.dict(sys.modules, {'indextts': pkg, 'indextts.infer_v2_5': mod_v25}):
                backend = synth.IndexTTS2PythonBackend(
                    model_dir=str(ckpt_dir),
                    cfg_path=str(cfg_file),
                    voice_prompt=str(host_wav),
                    cohost_voice_prompt=str(cohost_wav),
                    device='cpu',
                )
                ident = backend.cache_identity()
                self.assertEqual(ident['pkgVersion'], '2.5.2')
                self.assertEqual(ident['modelDir'], str(ckpt_dir.resolve()))
                self.assertEqual(ident['cfgSha256'], synth.sha256_file(cfg_file))
                self.assertEqual(ident['useFp16'], False)

                manifest = synth.synthesize_podcast_script(
                    script, backend=backend, output_path=tmp / 'out25.wav', cache_dir=tmp / 'c25', emo_alpha=0.8, audio_format='wav'
                )
                self.assertEqual(manifest['ttsEngine'], 'indextts-2.5')
                self.assertEqual(len(v25_calls), 4)
                for call in v25_calls:
                    self.assertEqual(call['generation_kwargs'], {})
                    self.assertEqual(call['lang'], 'ZH')
                    self.assertEqual(call['use_random'], False)
                self.assertEqual(v25_calls[0]['spk_audio_prompt'], str(host_wav))
                self.assertEqual(v25_calls[1]['spk_audio_prompt'], str(cohost_wav))
                self.assertEqual(v25_calls[1]['emo_vector'], synth.EMOTION_HINT_VECTORS['enthusiastic'])

            # v1 fallback with **generation_kwargs: MUST NOT pass spk_audio_prompt alongside audio_prompt!
            mini = {
                'contract': 'daily-podcast-script',
                'date': '2026-11-24',
                'title': 't',
                'scriptSha256': 'd' * 64,
                'segments': [{'id': 'intro', 'role': 'host', 'title': '开场', 'text': '你好。', 'emotionHint': 'warm', 'pauseMsAfter': 100}],
            }
            with mock.patch.dict(sys.modules, {'indextts': pkg, 'indextts.infer_v2_5': None, 'indextts.infer_v2': None, 'indextts.infer': mod_v1}):
                b1 = synth.IndexTTS2PythonBackend(model_dir=str(ckpt_dir), cfg_path=str(cfg_file), voice_prompt=str(host_wav), device='cpu')
                m1 = synth.synthesize_podcast_script(mini, backend=b1, output_path=tmp / 'v1.wav', cache_dir=tmp / 'c1', audio_format='wav')
                self.assertEqual(m1['ttsEngine'], 'indextts-1')
                self.assertEqual(len(v1_calls), 1)
                self.assertEqual(v1_calls[0]['generation_kwargs'], {})
                self.assertEqual(v1_calls[0]['audio_prompt'], str(host_wav))

    def test_indextts_http_ssrf_ipv6_special_prefixes_port0_and_loopback_isolation(self):
        blocked_urls = [
            '',
            'file:///etc/passwd',
            'ftp://tts.example.com/model',
            'https://user:pass@tts.example.com/v1/audio/speech',
            'http://tts.example.com/v1/audio/speech',
            'http://127.0.0.1:0/v1/audio/speech',
            'https://tts.example.com:0/v1/audio/speech',
            'http://169.254.169.254/latest/meta-data/',
            'https://169.254.169.254/v1/audio/speech',
            'https://10.0.0.12:8000/v1/audio/speech',
            'https://172.16.0.5/v1/audio/speech',
            'https://192.168.1.99/v1/audio/speech',
            'https://[::ffff:169.254.169.254]/v1/audio/speech',
            'https://[::ffff:0:0:127.0.0.1]/v1/audio/speech',
            'https://[::127.0.0.1]/v1/audio/speech',
            'https://[64:ff9b::169.254.169.254]/v1/audio/speech',
            'https://[64:ff9b:1::10.0.0.1]/v1/audio/speech',
            'https://[fec0::1]/v1/audio/speech',
            'https://[100::1]/v1/audio/speech',
            'https://[2001:db8::1]/v1/audio/speech',
            'https://[2001::1]/v1/audio/speech',
            'https://[2002:7f00:1::1]/v1/audio/speech',
            'https://[2002:a9fe:a9fe::1]/v1/audio/speech',
            'https://[::1]:8000/v1/audio/speech',
            'http://127.0.0.1:8000/v1/audio/speech',
            'https://tts.example.com/v1/audio/speech\r\nX-Injected: 1',
            'https://tts.example.com/v1/audio/speech HTTP/1.1',
            ' https://tts.example.com/v1/audio/speech',
            'https://tts.example.com/v1/audio/speech ',
            'https://tts.example.com/a\tb',
            'https://metadata.google.internal/computeMetadata/v1/',
        ]
        for bad in blocked_urls:
            with self.assertRaises(synth.EndpointValidationError, msg=f'Should reject {bad}'):
                synth.validate_indextts_endpoint(bad, allow_loopback=False)

        # Port 0 MUST STILL be rejected even with allow_loopback=True
        with self.assertRaises(synth.EndpointValidationError):
            synth.validate_indextts_endpoint('http://127.0.0.1:0/v1/audio/speech', allow_loopback=True)

        # External hostname resolving to 127.0.0.1 or ::1 MUST BE BLOCKED even with allow_loopback=True! (Finding 2)
        def dns_loopback(_host, _port):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]

        with self.assertRaises(synth.EndpointValidationError):
            synth.validate_indextts_endpoint(
                'https://evil.example.com/v1/audio/speech',
                allow_loopback=True,
                dns_resolver=dns_loopback,
            )
        with self.assertRaises(synth.EndpointValidationError):
            synth.validate_indextts_endpoint('http://evil.localhost:8000/v1/audio/speech', allow_loopback=True)

        # Exact localhost pinned exclusively to loopback IPs when allow_loopback=True
        loc = synth.validate_indextts_endpoint('http://localhost:8000/v1/audio/speech', allow_loopback=True)
        self.assertEqual(loc['resolvedIps'], ['127.0.0.1', '::1'])
        self.assertTrue(loc['isLoopback'])

    def test_pinned_https_connection_bypasses_proxy_checks_peer_ip_and_sni(self):
        # Verify _PinnedHTTPSConnection dials pinned IP directly even with ambient HTTPS_PROXY,
        # verifies peer IP match, and sets TLS server_hostname + CERT_REQUIRED (Finding 1)
        dialed = []
        wrapped_calls = []

        class FakeRawSock:
            def __init__(self, peer_ip):
                self._peer_ip = peer_ip
                self.closed = False

            def getpeername(self):
                return (self._peer_ip, 443)

            def close(self):
                self.closed = True

        class FakeSslCtx:
            def __init__(self):
                self.check_hostname = False
                self.verify_mode = ssl.CERT_NONE

            def wrap_socket(self, sock, server_hostname=None):
                wrapped_calls.append((sock, server_hostname, self.check_hostname, self.verify_mode))
                return sock

        with mock.patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:9999', 'HTTP_PROXY': 'http://127.0.0.1:9999'}):
            # Happy path: peer matches pinned IP
            with mock.patch.object(synth.socket, 'create_connection', side_effect=lambda addr, timeout: (dialed.append(addr), FakeRawSock('93.184.216.34'))[1]), \
                 mock.patch.object(synth.ssl, 'create_default_context', return_value=FakeSslCtx()):
                conn = synth._PinnedHTTPSConnection('93.184.216.34', 443, server_hostname='tts.example.com', timeout=10.0)
                conn.connect()
                self.assertEqual(dialed, [('93.184.216.34', 443)])
                self.assertEqual(wrapped_calls[0][1], 'tts.example.com')
                self.assertEqual(wrapped_calls[0][2], True)
                self.assertEqual(wrapped_calls[0][3], ssl.CERT_REQUIRED)

            # Peer IP mismatch -> must close socket and raise EndpointValidationError
            mismatch_sock = FakeRawSock('169.254.169.254')
            with mock.patch.object(synth.socket, 'create_connection', return_value=mismatch_sock), \
                 mock.patch.object(synth.ssl, 'create_default_context', return_value=FakeSslCtx()):
                conn_bad = synth._PinnedHTTPSConnection('93.184.216.34', 443, server_hostname='tts.example.com', timeout=10.0)
                with self.assertRaises(synth.EndpointValidationError):
                    conn_bad.connect()
                self.assertTrue(mismatch_sock.closed)

    def test_indextts_http_no_retry_on_fatal_3xx_size_cap_hls_bad_json_and_query_redaction(self):
        def dns_public(_host, _port):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]

        tone_bytes = make_tone_wav_bytes(0.2)

        def make_backend(responder, *, endpoint='https://tts.example.com/v1/audio/speech?api_key=super_secret', retries=2, timeout=5.0):
            logs = []

            def factory(**kwargs):
                return FakePinnedConnection(**kwargs, responder=responder, log_list=logs)

            backend = synth.IndexTTSHttpBackend(
                endpoint=endpoint,
                voice_prompt='host_voice',
                cohost_voice_prompt='cohost_voice',
                api_key='bearer-secret',
                retries=retries,
                timeout_seconds=timeout,
                dns_resolver=dns_public,
                connection_factory=factory,
            )
            return backend, logs

        # Query string MUST be redacted in cache_identity()
        b_redacted, _ = make_backend(lambda _req, _c: FakePinnedResponse(tone_bytes))
        self.assertNotIn('super_secret', b_redacted.cache_identity()['endpoint'])
        self.assertEqual(b_redacted.cache_identity()['endpoint'], 'https://tts.example.com/v1/audio/speech')

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)

            # 1. 3xx redirect -> immediate EndpointValidationError, 0 retries, query redacted!
            b_redir, redir_logs = make_backend(lambda _req, _c: FakePinnedResponse(b'', status=302, headers={'Location': 'http://169.254.169.254/'}))
            with self.assertRaises(synth.EndpointValidationError) as ctx:
                b_redir.synthesize_chunk(
                    text='测试', output_wav=tmp / 'r.wav', role='host',
                    emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
                )
            self.assertEqual(len(redir_logs), 1)
            self.assertNotIn('super_secret', str(ctx.exception))

            # 2. Content-Length > MAX_HTTP_AUDIO_BYTES -> immediate non-retryable failure (1 attempt)
            b_big, big_logs = make_backend(
                lambda _req, _c: FakePinnedResponse(b'x', status=200, headers={'Content-Length': str(synth.MAX_HTTP_AUDIO_BYTES + 1)})
            )
            with self.assertRaises(synth._NonRetryableIndexTTSError):
                b_big.synthesize_chunk(
                    text='测试', output_wav=tmp / 'b.wav', role='host',
                    emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
                )
            self.assertEqual(len(big_logs), 1)

            # 3. Malicious HLS #EXTM3U & ffconcat payloads -> rejected BEFORE ffmpeg, 0 retries! (Finding 3)
            for malicious in (
                b'#EXTM3U\n#EXT-X-TARGETDURATION:10\nfile:///etc/passwd\n',
                b'ffconcat version 1.0\nfile /etc/passwd\n',
            ):
                b_mal, mal_logs = make_backend(lambda _req, _c, m=malicious: FakePinnedResponse(m, status=200))
                with mock.patch.object(synth.subprocess, 'run') as mock_sub:
                    with self.assertRaises(synth._NonRetryableIndexTTSError):
                        b_mal.synthesize_chunk(
                            text='测试', output_wav=tmp / 'm.wav', role='host',
                            emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
                        )
                    self.assertEqual(len(mal_logs), 1)
                    mock_sub.assert_not_called()

            # 4. Non-dict JSON & invalid base64 -> immediate non-retryable failure
            for bad_json in (b'  [1, 2, 3]', b'{"audio_base64": "!!!not-valid-b64!!!"}'):
                b_j, j_logs = make_backend(
                    lambda _req, _c, bj=bad_json: FakePinnedResponse(bj, status=200, headers={'Content-Type': 'application/json'})
                )
                with self.assertRaises(synth._NonRetryableIndexTTSError):
                    b_j.synthesize_chunk(
                        text='测试', output_wav=tmp / 'j.wav', role='host',
                        emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
                    )
                self.assertEqual(len(j_logs), 1)

            # 5. Transient 502 retries once and succeeds with OpenAI-compatible payload & Host header
            state = {'n': 0}

            def flaky_responder(_req, _c):
                state['n'] += 1
                if state['n'] == 1:
                    return FakePinnedResponse(b'bad gateway', status=502)
                return FakePinnedResponse(tone_bytes, status=200, headers={'Content-Type': 'audio/wav'})

            b_ok, ok_logs = make_backend(flaky_responder, retries=1)
            out_ok = tmp / 'ok.wav'
            b_ok.synthesize_chunk(
                text='正常请求。', output_wav=out_ok, role='cohost',
                emotion_hint='analytical', emo_vector=synth.EMOTION_HINT_VECTORS['analytical'], emo_alpha=0.75, sample_rate=44100
            )
            self.assertEqual(len(ok_logs), 2)
            self.assertTrue(synth.is_valid_wav_file(out_ok, expected_sample_rate=44100))
            self.assertEqual(ok_logs[-1]['pinned_ip'], '93.184.216.34')
            self.assertEqual(ok_logs[-1]['headers']['Host'], 'tts.example.com')
            self.assertEqual(ok_logs[-1]['headers']['Authorization'], 'Bearer bearer-secret')
            self.assertEqual(ok_logs[-1]['body']['model'], 'IndexTeam/IndexTTS-2.5')
            self.assertEqual(ok_logs[-1]['body']['voice'], 'cohost_voice')
            # openai-speech wire payload must merge custom IndexTTS fields at top level (no client-SDK extra_body)
            self.assertNotIn('extra_body', ok_logs[-1]['body'])
            self.assertEqual(ok_logs[-1]['body']['spk_audio_prompt'], 'cohost_voice')
            self.assertEqual(ok_logs[-1]['body']['emo_vector'], synth.EMOTION_HINT_VECTORS['analytical'])
            self.assertEqual(ok_logs[-1]['body']['emo_alpha'], 0.75)
            self.assertEqual(ok_logs[-1]['body']['emotion_hint'], 'analytical')
            self.assertEqual(ok_logs[-1]['body']['role'], 'cohost')

            # 6. Custom JSON base64 with leading whitespace succeeds
            b64_payload = b'  ' + json.dumps({'audio_base64': base64.b64encode(tone_bytes).decode('ascii')}).encode('utf-8')
            b_json, _ = make_backend(
                lambda _req, _c: FakePinnedResponse(b64_payload, status=200, headers={'Content-Type': 'application/json'}),
                endpoint='https://tts.example.com/synthesize',
            )
            out_json = tmp / 'json.wav'
            b_json.synthesize_chunk(
                text='自定义 JSON。', output_wav=out_json, role='host',
                emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
            )
            self.assertTrue(synth.is_valid_wav_file(out_json, expected_sample_rate=44100))

            # 7. Sniff valid magic bytes for wav/mp3/flac/ogg/mov & ffmpeg safe args check
            self.assertEqual(synth.sniff_audio_demuxer(tone_bytes), 'wav')
            self.assertEqual(synth.sniff_audio_demuxer(b'ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00'), 'mp3')
            self.assertEqual(synth.sniff_audio_demuxer(b'\xff\xfb\x90\x00' + b'\x00' * 12), 'mp3')
            self.assertEqual(synth.sniff_audio_demuxer(b'fLaC' + b'\x00' * 12), 'flac')
            self.assertEqual(synth.sniff_audio_demuxer(b'OggS' + b'\x00' * 12), 'ogg')
            self.assertEqual(synth.sniff_audio_demuxer(b'\x00\x00\x00\x18ftypM4A '), 'mov')

            # Verify ffmpeg transcode uses -protocol_whitelist file, -f mp3, -vn -sn -dn -t 180, file:<abs>, timeout=60
            captured_cmd = {}

            def fake_ffmpeg(cmd, **kwargs):
                captured_cmd['cmd'] = cmd
                captured_cmd['timeout'] = kwargs.get('timeout')
                out_arg = cmd[-1]
                Path(out_arg.removeprefix('file:')).write_bytes(tone_bytes)
                return types.SimpleNamespace(returncode=0, stderr='')

            with mock.patch.object(synth.shutil, 'which', return_value='/usr/bin/ffmpeg'), \
                 mock.patch.object(synth.subprocess, 'run', side_effect=fake_ffmpeg):
                synth.convert_audio_bytes_to_wav(b'ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00', tmp / 'mp3_in.wav', sample_rate=44100)
                cmd = captured_cmd['cmd']
                self.assertIn('-protocol_whitelist', cmd)
                self.assertEqual(cmd[cmd.index('-protocol_whitelist') + 1], 'file')
                self.assertEqual(cmd[cmd.index('-f') + 1], 'mp3')
                self.assertIn('-vn', cmd)
                self.assertIn('-sn', cmd)
                self.assertIn('-dn', cmd)
                self.assertEqual(cmd[cmd.index('-t') + 1], '180')
                self.assertTrue(cmd[cmd.index('-i') + 1].startswith('file:'))
                self.assertEqual(captured_cmd['timeout'], 60)

            # 8. Wall-clock deadline aborts slow streaming read cleanly and closes response
            slow_resp = FakePinnedResponse(b'A' * (synth.HTTP_READ_CHUNK_BYTES * 3), status=200, chunk_delay=0.08)
            b_slow, _ = make_backend(lambda _req, _c: slow_resp, retries=0, timeout=0.12)
            with self.assertRaises(synth.IndexTTSError) as tctx:
                b_slow.synthesize_chunk(
                    text='超时测试', output_wav=tmp / 'slow.wav', role='host',
                    emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
                )
            self.assertIn('timed out', str(tctx.exception))
            self.assertTrue(slow_resp.closed)

            # 9. Valid public IPv6 unicast address passes SSRF check
            def dns_pub_v6(_host, _port):
                return [(socket.AF_INET6, socket.SOCK_STREAM, 6, '', ('2606:2800:220:1:248:1893:25c8:1946', 443, 0, 0))]

            v6_ok = synth.validate_indextts_endpoint('https://tts.example.com/v1/audio/speech', dns_resolver=dns_pub_v6)
            self.assertEqual(v6_ok['resolvedIps'], ['2606:2800:220:1:248:1893:25c8:1946'])

            # 10. http.client.InvalidURL is non-retryable EndpointValidationError with query secret redacted
            inv_attempts = {'n': 0}

            def invalid_url_factory(**kwargs):
                class InvConn:
                    def request(self, _m, target, **_kw):
                        inv_attempts['n'] += 1
                        raise synth.http.client.InvalidURL(f'bad target: {target}')
                    def close(self):
                        pass
                return InvConn()

            b_inv = synth.IndexTTSHttpBackend(
                endpoint='https://tts.example.com/v1/audio/speech?api_key=super_secret_xyz',
                retries=2,
                dns_resolver=dns_public,
                connection_factory=invalid_url_factory,
            )
            with self.assertRaises(synth.EndpointValidationError) as ictx:
                b_inv.synthesize_chunk(
                    text='测试', output_wav=tmp / 'inv.wav', role='host',
                    emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
                )
            self.assertEqual(inv_attempts['n'], 1)
            self.assertNotIn('super_secret_xyz', str(ictx.exception))

            # 11. Multi-IP / ::1 failover: localhost fails over from refused 127.0.0.1 to ::1 on attempt 1!
            dialed_ips = []

            def failover_factory(**kwargs):
                ip = kwargs['pinned_ip']
                dialed_ips.append(ip)
                if ip == '127.0.0.1':
                    class RefusedConn:
                        def request(self, *_a, **_kw):
                            raise ConnectionRefusedError('127.0.0.1 refused')
                        def close(self):
                            pass
                    return RefusedConn()
                return FakePinnedConnection(**kwargs, responder=lambda _r, _c: FakePinnedResponse(tone_bytes), log_list=[])

            b_loc = synth.IndexTTSHttpBackend(
                endpoint='http://localhost:8000/v1/audio/speech',
                allow_loopback=True,
                retries=0,
                connection_factory=failover_factory,
            )
            out_v6 = tmp / 'localhost_v6.wav'
            b_loc.synthesize_chunk(
                text='本地双栈测试', output_wav=out_v6, role='host',
                emotion_hint='calm', emo_vector=synth.EMOTION_HINT_VECTORS['calm'], emo_alpha=0.75, sample_rate=44100
            )
            self.assertEqual(dialed_ips, ['127.0.0.1', '::1'])
            self.assertTrue(synth.is_valid_wav_file(out_v6, expected_sample_rate=44100))

            # 12. Tightened raw MPEG MP3 sync check & mov -enable_drefs 0 defense-in-depth
            with self.assertRaises(synth._NonRetryableIndexTTSError):
                synth.sniff_audio_demuxer(b'\xff\xfb\xf0\x00' + b'\x00' * 12)  # invalid bitrate index 0xF
            with self.assertRaises(synth._NonRetryableIndexTTSError):
                synth.sniff_audio_demuxer(b'\xff\xfb\x9c\x00' + b'\x00' * 12)  # reserved sample-rate index 0x3

            mov_cmd = {}

            def fake_mov_ffmpeg(cmd, **_kw):
                mov_cmd['cmd'] = cmd
                Path(cmd[-1].removeprefix('file:')).write_bytes(tone_bytes)
                return types.SimpleNamespace(returncode=0, stderr='')

            with mock.patch.object(synth.shutil, 'which', return_value='/usr/bin/ffmpeg'), \
                 mock.patch.object(synth.subprocess, 'run', side_effect=fake_mov_ffmpeg):
                synth.convert_audio_bytes_to_wav(b'\x00\x00\x00\x18ftypM4A ' + b'\x00' * 12, tmp / 'mov_in.wav', sample_rate=44100)
                self.assertIn('-enable_drefs', mov_cmd['cmd'])
                self.assertEqual(mov_cmd['cmd'][mov_cmd['cmd'].index('-enable_drefs') + 1], '0')

    def test_cli_arg_parser_env_booleans_and_empty_model_dir(self):
        for truthy in ('1', 'true', 'TRUE', ' yes ', 'On'):
            with mock.patch.dict(os.environ, {'PD_INDEXTTS_ALLOW_LOCAL_ENDPOINT': truthy}, clear=False):
                args = synth.build_arg_parser().parse_args([])
                self.assertTrue(args.allow_local_endpoint, f'expected True for {truthy!r}')
        for falsy in ('', '0', 'false', 'no', 'off', '   '):
            with mock.patch.dict(os.environ, {'PD_INDEXTTS_ALLOW_LOCAL_ENDPOINT': falsy}, clear=False):
                args = synth.build_arg_parser().parse_args([])
                self.assertFalse(args.allow_local_endpoint, f'expected False for {falsy!r}')
        for empty_dir in ('', '   '):
            with mock.patch.dict(os.environ, {'PD_INDEXTTS_MODEL_DIR': empty_dir}, clear=False):
                args = synth.build_arg_parser().parse_args([])
                self.assertEqual(args.model_dir, 'checkpoints')

    def test_cli_sandbox_guard(self):
        env = dict(os.environ, CODEX_SANDBOX='seatbelt')
        res = subprocess.run(
            ['bash', str(SCRIPTS_DIR / 'python-runtime.sh'), str(SCRIPTS_DIR / 'indextts_synth.py'), '--check-env'],
            cwd=str(REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn('CODEX_SANDBOX', res.stderr)


if __name__ == '__main__':
    unittest.main()
