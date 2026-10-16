import { setLicenseKey } from '../../src-ts/license.js';
import licenses from '../fixtures/w21/licenses.json';
await setLicenseKey(licenses.active);
