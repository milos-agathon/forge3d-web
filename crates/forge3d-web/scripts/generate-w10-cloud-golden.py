"""Public installed-native Scene cloud pass, including a disabled control."""
from pathlib import Path
import json, hashlib
import numpy as np
from PIL import Image
import forge3d as f3d
from forge3d import _forge3d

assert f3d.__version__ == '1.34.0'
out=Path(__file__).resolve().parents[1]/'tests/golden/w10/native'
scene=f3d.Scene(192,128)
scene.set_camera_look_at((0,10,0),(0,20,0),(0,0,1),55,0.1,500)
control=np.ascontiguousarray(scene.render_rgba())
Image.fromarray(control).save(out/'cloud-disabled.png')
scene.enable_clouds('medium')
scene.set_cloud_render_mode('volumetric')
image=np.ascontiguousarray(scene.render_rgba())
assert np.array_equal(image,scene.render_rgba())
assert np.mean(np.abs(image.astype(float)-control)) > 0.1
Image.fromarray(image).save(out/'cloud.png')
(out/'cloud.rgba').write_bytes(image.tobytes())
print(json.dumps(dict(native='forge3d 1.34.0',extensionSha256=hashlib.sha256(Path(_forge3d.__file__).read_bytes()).hexdigest(),sha256=hashlib.sha256(image.tobytes()).hexdigest())))
