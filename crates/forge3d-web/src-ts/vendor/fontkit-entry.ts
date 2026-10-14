// The pinned fontkit ESM contains a regenerator-compiled Indic state machine.
// Include its exact runtime in every realm (source, dist, bundles and workers).
import 'regenerator-runtime/runtime.js';
import * as fontkit from '@pdf-lib/fontkit';
const api = 'default' in fontkit ? fontkit.default as typeof fontkit : fontkit;
export default api;
