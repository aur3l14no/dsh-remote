import { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-subprocess';
import { ShellExecutor } from '@deepseek-ai/dsh-shell';
import { RemoteError } from '../../../../../../runtime/client/src/index.ts';

/** Borrow explicitly composed native providers; disposing this owner never tears down the host. */
export function openLocalWorld(native: Context | undefined): Context {
  const fs = native?.get('fs');
  const subprocess = native?.get('subprocess');
  if (!fs || !subprocess) throw new RemoteError('WORLD_NOT_READY', 'Native local providers are unavailable');
  const owner = new Context();
  const shell = native?.get('shell');
  // Cordis rebinds borrowed Service.ctx to the consumer. Delegate through the
  // captured native service so its sandbox and other host dependencies stay intact.
  if (shell) new class extends ShellExecutor {
    override get sandboxMode() { return shell.sandboxMode; }
    resolve(...args: Parameters<ShellExecutor['resolve']>) { return shell.resolve(...args); }
    run(...args: Parameters<ShellExecutor['run']>) { return shell.run(...args); }
    start(...args: Parameters<ShellExecutor['start']>) { return shell.start(...args); }
  }(owner);
  owner.provide('fs', fs);
  owner.provide('subprocess', subprocess);
  return owner;
}
