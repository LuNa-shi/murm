import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HarnessRpcClient } from '@luna-shi/murm';

export function connect() {
  const harness = fileURLToPath(new URL('./project.js', import.meta.url));
  const child = spawn('murm', ['--harness', harness, '--mode', 'rpc', '--lifetime', 'interactive', '--interaction', 'questions'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return { child, session: new HarnessRpcClient(child) };
}
