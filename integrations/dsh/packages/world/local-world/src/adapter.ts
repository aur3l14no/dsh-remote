import { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-subprocess';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';

/** Borrow explicitly composed native providers; disposing this owner never tears down the host. */
export function openLocalWorld(native: Context | undefined): Context {
  const fs = native?.get('fs');
  const subprocess = native?.get('subprocess');
  if (!fs || !subprocess) throw new RemoteError('WORLD_NOT_READY', 'Native local providers are unavailable');
  const owner = new Context();
  owner.provide('fs', fs);
  owner.provide('subprocess', subprocess);
  return owner;
}
