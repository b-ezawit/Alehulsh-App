import { createWorkersApp } from './app.js';
import { runWorkerTasks, type TaskBindings } from './taskRuntime.js';
const app = createWorkersApp();
// No Cron trigger or remote bindings are configured by the local review file.
// Protected HTTP routes still require the injected live session checker.
export default {
  fetch: app.fetch,
  async scheduled(_controller: unknown, env: TaskBindings): Promise<void> { await runWorkerTasks(env); },
};
