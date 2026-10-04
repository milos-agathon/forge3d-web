"""Inventory the immutable native W13 test definitions and their browser ports."""
import ast,hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BASELINE=subprocess.check_output(['git','rev-parse','1f4084a'],cwd=ROOT,text=True).strip()
files=subprocess.check_output(['git','ls-tree','-r','--name-only',BASELINE,'tests'],cwd=ROOT,text=True).splitlines()
files=[p for p in files if any(t in p for t in ['test_label_api_','test_label_plan_','test_labels_pybindings','test_mapscene_label_plan','test_p1_label_','test_p1_typography_font','test_p2_advanced_label','test_p2_complex_shaping'])]
files.append('tests/test_api_contracts.py')
UNIT='crates/forge3d-web/tests/unit/'
rows=[]
for path in files:
 source=subprocess.check_output(['git','show',f'{BASELINE}:{path}'],cwd=ROOT,text=True,encoding='utf-8')
 tree=ast.parse(source)
 if path.endswith('test_api_contracts.py'): tree=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='TestLabelBindings')
 functions=[n.name for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name.startswith('test_')]
 if 'pybindings' in path: functions=['TestLabelBindings (proxy to test_api_contracts.py)']
 for name in functions:
  if 'docs' in path or any(t in name for t in ['docs','quickstart_names','example_exists','quickstart_points','truth_artifacts','prefer_viewerhandle','signatures']):
   ports=['crates/forge3d-web/tests/unit/label-contract-record.test.ts'];contract='Public browser guide, support boundaries, executable workflows and typed API exports.'
  elif 'plan_' in path or 'p2_' in path:
   ports=[UNIT+'labels.test.ts'];contract='Immutable native compiler oracle, including accepted/rejected order, candidates, diagnostics, IDs, reasons and payloads.'
  elif any(t in path for t in ['test_p1_label','test_mapscene_label']):
   ports=[UNIT+'label-workflows.test.ts',UNIT+'labels.test.ts'];contract='Native feature recipe oracles; browser row/style/CRS/sampler adapters; compiled plan and layer-scoped summary.'
  elif 'typography' in path:
   ports=[UNIT+'label-workflows.test.ts',UNIT+'labels.test.ts'];contract='Real font coverage/fallback, missing asset diagnostic, metrics, multiline/callout metadata and HarfBuzz shaping.'
  else:
   ports=[UNIT+'label-workflows.test.ts',UNIT+'labels.test.ts','crates/forge3d-web/tests/playwright/w13_labels.spec.ts'];contract='Typed public label workflow, stable IDs/configuration/removal/diagnostics, native style defaults, actual glyphs and viewer replay.'
  rows.append({'nativeFile':path,'definition':name,'nativeFileSha256':hashlib.sha256(source.encode()).hexdigest(),'ports':ports,'contract':contract})
output={'schemaVersion':1,'baseline':BASELINE,'deepNative':subprocess.check_output(['git','rev-parse','bf8db93'],cwd=ROOT,text=True).strip(),'policy':'Every native label test definition is assigned a browser outcome port. OS paths/IPC/PyO3/GeoDataFrame mechanisms adapt to font URLs, typed IDs, ESM exports and feature rows. W18 consumes the label-only recipe/validation adapter; W14 supplies CRS transforms. No unrelated MapScene or PROJ implementation is claimed.','nativeTestFiles':len(files),'definitions':rows}
(ROOT/'docs/parity/w13-native-test-coverage.json').write_text(json.dumps(output,indent=2)+'\n',encoding='utf-8')
print(f'{len(rows)} definitions across {len(files)} native test files mapped to browser ports')
