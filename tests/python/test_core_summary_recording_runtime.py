import ast
import re
import unittest
from pathlib import Path
source = (Path(__file__).resolve().parents[2] / 'scripts/publish-to-blog.py').read_text()
tree = ast.parse(source)
names = {'_has_recorded_dissonance_comparison', '_has_mean_room_simulation_comparison'}
selected = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
namespace = {'re': re}
exec(compile(selected, '<actual-publisher-functions>', 'exec'), namespace)
class RecordingRuntimeTests(unittest.TestCase):
    def test_boundaries(self):
        with self.subTest(text='在录音听辨比较中，塞萨里斯感觉不协和度从12.5任意单位增至34任意单位'):
            self.assertEqual(namespace['_has_recorded_dissonance_comparison']('在录音听辨比较中，塞萨里斯感觉不协和度从12.5任意单位增至34任意单位'), True)
        with self.subTest(text='假设在录音听辨比较中，塞萨里斯感觉不协和度从12.5增至34'):
            self.assertEqual(namespace['_has_recorded_dissonance_comparison']('假设在录音听辨比较中，塞萨里斯感觉不协和度从12.5增至34'), False)
        with self.subTest(text='在录音听辨比较中，塞萨里斯感觉不协和度从34增至12.5'):
            self.assertEqual(namespace['_has_recorded_dissonance_comparison']('在录音听辨比较中，塞萨里斯感觉不协和度从34增至12.5'), False)
        with self.subTest(text='在录音听辨比较中，塞萨里斯感觉不协和度从12.5小时增至34小时'):
            self.assertEqual(namespace['_has_recorded_dissonance_comparison']('在录音听辨比较中，塞萨里斯感觉不协和度从12.5小时增至34小时'), False)
        with self.subTest(text='塞萨里斯感觉不协和度从12.5增至34'):
            self.assertEqual(namespace['_has_recorded_dissonance_comparison']('塞萨里斯感觉不协和度从12.5增至34'), False)
        with self.subTest(text='在Apple MacBook Pro上按1000个房间平均的单房间平均空间房间脉冲响应仿真耗时为镜像源1阶0.49秒、2阶0.55秒、12阶1.26秒，12阶明显高于1阶和2阶'):
            self.assertEqual(namespace['_has_mean_room_simulation_comparison']('在Apple MacBook Pro上按1000个房间平均的单房间平均空间房间脉冲响应仿真耗时为镜像源1阶0.49秒、2阶0.55秒、12阶1.26秒，12阶明显高于1阶和2阶'), True)
        with self.subTest(text='在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶1.26秒、12阶0.49秒，12阶高于1阶'):
            self.assertEqual(namespace['_has_mean_room_simulation_comparison']('在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶1.26秒、12阶0.49秒，12阶高于1阶'), False)
        with self.subTest(text='在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49小时、12阶1.26小时，12阶高于1阶'):
            self.assertEqual(namespace['_has_mean_room_simulation_comparison']('在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49小时、12阶1.26小时，12阶高于1阶'), False)
        with self.subTest(text='在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于2阶'):
            self.assertEqual(namespace['_has_mean_room_simulation_comparison']('在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于2阶'), False)
        with self.subTest(text='本研究并未在录音听辨比较中记录数据，塞萨里斯感觉不协和度从12.5增至34'):
            self.assertFalse(namespace['_has_recorded_dissonance_comparison']('本研究并未在录音听辨比较中记录数据，塞萨里斯感觉不协和度从12.5增至34'))
        with self.subTest(text='将在录音听辨比较中，塞萨里斯感觉不协和度从12.5增至34'):
            self.assertFalse(namespace['_has_recorded_dissonance_comparison']('将在录音听辨比较中，塞萨里斯感觉不协和度从12.5增至34'))
        with self.subTest(text='并未在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于1阶'):
            self.assertFalse(namespace['_has_mean_room_simulation_comparison']('并未在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于1阶'))
        with self.subTest(text='将会在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于1阶'):
            self.assertFalse(namespace['_has_mean_room_simulation_comparison']('将会在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于1阶'))

if __name__ == '__main__':
    unittest.main()
