import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client } from '../../../../../../runtime/client/src/index.ts';

/** Applies only to this tool call and this concrete remote runtime. */
export const fileAuthorization = new AsyncLocalStorage<{ client: Client; root: string }>();
