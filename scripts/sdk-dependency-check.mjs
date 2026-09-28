import {verifyLockedSdk} from './sdk-dependency-verify.mjs';

const result = await verifyLockedSdk();
if (!result.ok) throw new Error(result.message);
