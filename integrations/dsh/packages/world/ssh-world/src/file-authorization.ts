import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResourceScope } from '../../../../../../runtime/client/src/index.ts';

/** Applies only to this tool call and this workspace resource scope; Cordis service proxies are not owner identities. */
export const fileAuthorization = new AsyncLocalStorage<{ owner: ResourceScope; root: string }>();
