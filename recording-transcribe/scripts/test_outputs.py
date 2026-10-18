import ast
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent


class OutputNamingTests(unittest.TestCase):
    def test_scripts_have_valid_syntax(self):
        for script in SCRIPTS.glob("*.py"):
            with self.subTest(script=script.name):
                ast.parse(script.read_text(encoding="utf-8"), filename=str(script))

    def test_english_outputs_feed_document_builder(self):
        for prefix in (None, "2026-10-18"):
            with self.subTest(prefix=prefix), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                transcripts = root / "transcripts"
                transcripts.mkdir()
                task = {"segments": [{"file": "ABC123-recording.m4a", "offset": 10, "duration": 30}], "markers": [11]}
                (root / "task.json").write_text(json.dumps(task), encoding="utf-8")
                (transcripts / "ABC123.json").write_text(json.dumps({"utterances": [{"start": 1, "end": 2, "text": "测试录音。"}]}, ensure_ascii=False), encoding="utf-8")
                command = [sys.executable, str(SCRIPTS / "assemble.py"), "--task-json", str(root / "task.json"), "--transcripts", str(transcripts), "--outdir", str(root)]
                if prefix is not None:
                    command.extend(["--prefix", prefix])
                subprocess.run(command, check=True, capture_output=True, text=True)
                output_prefix = prefix or "merged"
                expected = {f"{output_prefix}_transcript.md", f"{output_prefix}_segments.md", f"{output_prefix}_stats.json"}
                self.assertEqual({path.name for path in root.iterdir()} - {"task.json", "transcripts"}, expected)
                self.assertTrue(all(name.isascii() for name in expected))
                transcript = root / f"{output_prefix}_transcript.md"
                self.assertIn("[00:00:11.00] 测试录音。", transcript.read_text(encoding="utf-8"))
                self.assertIn("测试录音。", (root / f"{output_prefix}_segments.md").read_text(encoding="utf-8"))
                stats = json.loads((root / f"{output_prefix}_stats.json").read_text(encoding="utf-8"))
                self.assertEqual(stats["merged_utterances"], 1)
                for output in (None, "recording_body.md"):
                    command = [sys.executable, str(SCRIPTS / "build_doc.py"), "--transcript", str(transcript), "--task-json", str(root / "task.json")]
                    if output is not None:
                        command.extend(["--out", output])
                    subprocess.run(command, cwd=root, check=True, capture_output=True, text=True)
                    self.assertIn("测试录音。", (root / (output or "body.md")).read_text(encoding="utf-8"))

    def test_non_ascii_and_path_prefixes_are_rejected(self):
        for prefix in ("录音", "../recording", "day/log", ""):
            with self.subTest(prefix=prefix), tempfile.TemporaryDirectory() as temporary:
                command = [sys.executable, str(SCRIPTS / "assemble.py"), "--task-json", "unused.json", "--transcripts", "unused", "--prefix", prefix]
                result = subprocess.run(command, cwd=temporary, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("prefix must use ASCII", result.stderr)
                self.assertEqual(list(Path(temporary).iterdir()), [])


if __name__ == "__main__":
    unittest.main()