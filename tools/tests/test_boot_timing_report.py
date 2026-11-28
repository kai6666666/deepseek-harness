#!/usr/bin/env python3
"""`tools/boot-timing-report.py` 的回归门禁单测。

为什么用 importlib 而不是普通 import：文件名带 `-`（命令行习惯），
不能作为模块名引入。
为什么要有这些用例：CI 里那道「阈值门禁」如果自己坏了（解析不到字段 /
容差算错 / 该红不红），比没有门禁更危险 —— 它会给出虚假的安全感。
"""
import importlib.util
import json
import pathlib
import sys
import unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('boot_timing_report', ROOT / 'tools' / 'boot-timing-report.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)
FIX = ROOT / 'tools' / 'fixtures' / 'boot-timing'
BASELINE = json.loads((ROOT / 'tools' / 'boot-baseline.json').read_text(encoding='utf-8'))
def blocks(name):
    return MOD.parse_blocks((FIX / name).read_text(encoding='utf-8'))
class ParseTest(unittest.TestCase):
    def test_good_sample_has_one_block(self):
        self.assertEqual(len(blocks('debug51-cold.log')), 1)
    def test_key_fields_present(self):
        kv = blocks('debug51-cold.log')[0]['kv']
        for k in ('epoch.preload', 'host.epoch', 'epoch.first', 'modules.count'):
            self.assertIn(k, kv)
    def test_missing_block_is_detected(self):
        self.assertEqual(MOD.parse_blocks('nothing here'), [])
class MetricsTest(unittest.TestCase):
    def test_metrics_of_good(self):
        m = MOD.metrics_of(blocks('debug51-cold.log')[-1])
        self.assertEqual(m['preload_to_first_ms'], 13853)
        self.assertEqual(m['modules_count'], 247)
        self.assertEqual(m['modules_compile_ms'], 2337)
        self.assertEqual(m['listen_to_listening_ms'], 2143)
        self.assertEqual(m['total_host_to_first_ms'], 14085)
    def test_metrics_skip_na(self):
        blk = {'header': 'x', 'reason': '', 'kv': {'modules.count': 'na'}}
        self.assertNotIn('modules_count', MOD.metrics_of(blk))
class BaselineTest(unittest.TestCase):
    def test_good_passes(self):
        ok, fails, skips = MOD.check_baseline(
            MOD.metrics_of(blocks('debug51-cold.log')[-1]), BASELINE)
        self.assertTrue(ok, fails)
        self.assertEqual(skips, [])
    def test_regressed_fails_on_every_axis(self):
        ok, fails, _ = MOD.check_baseline(
            MOD.metrics_of(blocks('regressed.log')[-1]), BASELINE)
        self.assertFalse(ok)
        self.assertEqual(len(fails), 5, fails)
    def test_absolute_limit_wins_over_value(self):
        base = {'tolerance': 0.0, 'metrics': {'modules_count': {'limit': 300}}}
        ok, fails, _ = MOD.check_baseline({'modules_count': 301}, base)
        self.assertFalse(ok)
        ok2, _, _ = MOD.check_baseline({'modules_count': 300}, base)
        self.assertTrue(ok2)
    def test_required_metric_must_exist(self):
        base = {'metrics': {'modules_count': {'value': 247, 'required': True}}}
        ok, fails, _ = MOD.check_baseline({}, base)
        self.assertFalse(ok)
        self.assertIn('缺失', fails[0])
    def test_optional_metric_is_skipped(self):
        base = {'metrics': {'modules_count': {'value': 247}}}
        ok, _, skips = MOD.check_baseline({}, base)
        self.assertTrue(ok)
        self.assertEqual(len(skips), 1)
class CliTest(unittest.TestCase):
    def test_assert_good_exit_0(self):
        rc = MOD.main(['x', '--assert', '--baseline',
                       str(ROOT / 'tools' / 'boot-baseline.json'),
                       '--log', str(FIX / 'debug51-cold.log')])
        self.assertEqual(rc, 0)
    def test_assert_regressed_exit_1(self):
        rc = MOD.main(['x', '--assert', '--baseline',
                       str(ROOT / 'tools' / 'boot-baseline.json'),
                       '--log', str(FIX / 'regressed.log')])
        self.assertEqual(rc, 1)
    def test_no_args_exit_2(self):
        self.assertEqual(MOD.main(['x']), 2)
if __name__ == '__main__':
    unittest.main()
