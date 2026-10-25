#!/usr/bin/env python3
"""Exercises actual selection shell logic with isolated transports; never starts adb, Gradle or an app."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest
if os.environ.get('CODEX_SANDBOX'):
    raise SystemExit('Run Android checks outside the restricted execution environment.')
SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'test.sh'
class Selection(unittest.TestCase):
    def run_script(self, args, overrides=None):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);shutil.copyfile(SOURCE,root/'test.sh')
            (root/'build.sh').write_text('#!/bin/bash\npython3 -c \'import json,os,sys;open(os.environ["PD_CAPTURE"],"w").write(json.dumps({"serial":os.environ.get("ANDROID_SERIAL"),"args":sys.argv[1:]}))\' "$@"\n')
            (root/'adb').write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$PD_ADB_LOG"\n[[ "$1" == -s ]] || exit 91\nif [[ "$3" == get-state ]]; then echo "${PD_STATE:-device}";elif [[ "$3" == emu ]];then echo "${PD_AVD:-PaperDigest_QA_API35}";echo OK;else exit 92;fi\n')
            for f in ['build.sh','adb']: (root/f).chmod(0o700)
            env=dict(os.environ);env.update(PATH=str(root)+os.pathsep+env['PATH'],PD_CAPTURE=str(root/'capture'),PD_ADB_LOG=str(root/'adb.log'),ANDROID_SERIAL='')
            env.update(overrides or {})
            result=subprocess.run(['bash',str(root/'test.sh'),*args],env=env,text=True,capture_output=True)
            capture=json.loads((root/'capture').read_text()) if (root/'capture').exists() else None
            commands=(root/'adb.log').read_text() if (root/'adb.log').exists() else ''
            return result,capture,commands
    def test_missing_selection_stops_before_adb_and_build(self):
        r,c,a=self.run_script(['--device']);self.assertNotEqual(0,r.returncode);self.assertIsNone(c);self.assertEqual('',a)
    def test_multiple_serials_are_not_an_implicit_all_devices_opt_in(self):
        for serial in ['emulator-5580,emulator-5554','emulator-5580 emulator-5582']:
            r,c,a=self.run_script(['--device'],{'ANDROID_SERIAL':serial});self.assertNotEqual(0,r.returncode);self.assertIsNone(c);self.assertEqual('',a)
    def test_explicit_qa_serial_is_the_only_gradle_target(self):
        r,c,a=self.run_script(['--device','emulator-5580','-Pexample=true']);self.assertEqual(0,r.returncode,r.stderr);self.assertEqual('emulator-5580',c['serial']);self.assertEqual([':app:connectedDebugAndroidTest','-Pexample=true'],c['args']);self.assertTrue(all(x.startswith('-s emulator-5580 ') for x in a.splitlines()))
    def test_passthrough_device_override_cannot_escape_selection(self):
        for override in ['--serial=emulator-5554','--serial','-Pandroid.injected.device.serial=emulator-5554']:
            r,c,a=self.run_script(['--device','emulator-5580',override]);self.assertNotEqual(0,r.returncode);self.assertIsNone(c);self.assertEqual('',a)
    def test_plain_branch_cannot_inject_any_device_task_or_abbreviation(self):
        for task in [':app:connectedDebugAndroidTest','connectedDebugAndroidTest',':app:cDAT','installDebug']:
            r,c,a=self.run_script([task]);self.assertNotEqual(0,r.returncode);self.assertIsNone(c);self.assertEqual('',a)
    def test_device_branch_cannot_append_another_task(self):
        r,c,a=self.run_script(['--device','emulator-5580',':app:connectedDebugAndroidTest']);self.assertNotEqual(0,r.returncode);self.assertIsNone(c);self.assertEqual('',a)
    def test_env_selection_is_checked_and_preserved(self):
        r,c,a=self.run_script(['--device'],{'ANDROID_SERIAL':'emulator-5582','PD_AVD':'PaperDigest_QA_API28'});self.assertEqual(0,r.returncode,r.stderr);self.assertEqual('emulator-5582',c['serial'])
    def test_other_avd_is_rejected_even_if_selected(self):
        r,c,a=self.run_script(['--device','emulator-5554'],{'PD_AVD':'Zhanguan_API_35'});self.assertNotEqual(0,r.returncode);self.assertIsNone(c);self.assertNotIn('devices',a)
    def test_offline_target_cannot_start_build(self):
        r,c,a=self.run_script(['--device','emulator-5580'],{'PD_STATE':'offline'});self.assertNotEqual(0,r.returncode);self.assertIsNone(c)
    def test_restricted_environment_is_rejected_before_transport(self):
        r,c,a=self.run_script(['--device','emulator-5580'],{'CODEX_SANDBOX':'1'});self.assertNotEqual(0,r.returncode);self.assertIsNone(c);self.assertEqual('',a)
    def test_explicit_physical_serial_does_not_enumerate_or_select_another(self):
        r,c,a=self.run_script(['--device','explicit-physical-serial']);self.assertEqual(0,r.returncode,r.stderr);self.assertEqual('explicit-physical-serial',c['serial']);self.assertEqual('-s explicit-physical-serial get-state\n',a)
if __name__=='__main__':unittest.main()
