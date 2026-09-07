"""Offline optical invariants evaluated from the production GLSL expressions.

This tests the actual scalar compositing expressions, not a second copy of
the mask algorithm. Texture lookup, projection and GPU compilation still
require the native render QA; no OpenGL or extra Python packages are needed.
"""
import importlib.util
from pathlib import Path
import re
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]
SHADER = (ROOT / 'touchdesigner/cinematic/title.frag').read_text()
spec = importlib.util.spec_from_file_location(
    'td_title_layer', ROOT / 'touchdesigner/cinematic/title_layer.py')
title_layer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(title_layer)


def clamp(value, low, high):
    return max(low, min(high, value))


def smoothstep(low, high, value):
    t = clamp((value - low) / (high - low), 0, 1)
    return t * t * (3 - 2 * t)


def declaration(name):
    match = re.search(r'\b(?:float|vec3)\s+' + name + r'\s*=([^;]+);', SHADER)
    if not match:
        raise AssertionError('Production shader declaration missing: ' + name)
    return ' '.join(match.group(1).split())


def sample(scene, core_alpha=0, opacity=0.22, facing=1, ink=(0.89, 0.875, 0.82)):
    environment = {
        'scene': SimpleNamespace(r=scene[0], g=scene[1], b=scene[2]),
        'lettering': SimpleNamespace(),
        'uTitleShape': SimpleNamespace(w=opacity),
        'texture': lambda *_: SimpleNamespace(a=core_alpha),
        'sTD2DInputs': [None, None, None], 'uv': None,
        'facing': facing, 'clamp': clamp, 'smoothstep': smoothstep, 'max': max,
    }
    for name in ('coreOpacity', 'scenePeak', 'starlightProtection', 'visibility'):
        environment[name] = eval(declaration(name), {'__builtins__': {}}, environment)
    result = []
    for scene_channel, ink_channel in zip(scene, ink):
        environment['scene'].rgb = scene_channel
        environment['lettering'].rgb = ink_channel
        result.append(eval(declaration('result'), {'__builtins__': {}}, environment))
    return tuple(result)


class TitleOpticalContract(unittest.TestCase):
    def test_opaque_horizon_and_plasma_cannot_receive_text(self):
        for background in ((0, 0, 0), (0.02, 0.04, 0.01), (0.5, 0.3, 0.2)):
            self.assertEqual(sample(background, core_alpha=1), background)

    def test_bright_stars_retain_exact_color_and_brightness(self):
        for star in ((0.12, 0.02, 0.01), (0.2, 0.3, 0.7), (1, 0.91, 0.8)):
            self.assertEqual(sample(star), star)

    def test_zero_opacity_is_exact_bypass(self):
        scene = (0.009, 0.006, 0.01)
        self.assertEqual(sample(scene, opacity=0), scene)

    def test_partial_volume_transmission_hides_title_gradually(self):
        clear = sample((0, 0, 0), core_alpha=0)
        middle = sample((0, 0, 0), core_alpha=0.5)
        for bright, dim in zip(clear, middle):
            self.assertAlmostEqual(dim, bright * 0.5)

    def test_title_never_dims_or_tints_existing_scene_by_multiplication(self):
        # Multiple scene and opacity levels exercise the entire protection ramp.
        for level in (0, 0.008, 0.018, 0.04, 0.07, 0.119, 0.3, 1):
            scene = (level, level * 0.8, level * 0.6)
            for opacity in (0, 0.1, 0.22, 0.65):
                result = sample(scene, opacity=opacity)
                self.assertTrue(all(after >= before for after, before in zip(result, scene)))

    def test_transparent_native_glyph_pixels_leave_scene_unchanged(self):
        scene = (0.012, 0.008, 0.014)
        self.assertEqual(sample(scene, ink=(0, 0, 0)), scene)


class NativeTitleCompatibility(unittest.TestCase):
    def test_current_and_legacy_position_names(self):
        for names in (('positionx', 'positiony'), ('position1', 'position2')):
            parameters = SimpleNamespace(**{name: SimpleNamespace(val=None) for name in names})
            title_layer._position(SimpleNamespace(par=parameters), 3, -9)
            self.assertEqual([getattr(parameters, name).val for name in names], [3, -9])

    def test_free_text_font_and_dynamic_menu(self):
        font = SimpleNamespace(menuNames=[], menuLabels=[], val='')
        node = SimpleNamespace(par=SimpleNamespace(font=font))
        self.assertTrue(title_layer._menu(node, 'font', ('Helvetica Neue', 'Arial')))
        self.assertEqual(font.val, 'Helvetica Neue')
        font.menuNames = ['Arial', 'Helvetica Neue']
        font.menuLabels = font.menuNames[:]
        self.assertTrue(title_layer._menu(node, 'font', ('Helvetica Neue', 'Arial')))
        self.assertEqual(font.val, 'Helvetica Neue')


if __name__ == '__main__':
    unittest.main()
