import { selfTest, scenario, assertTrue } from '../self-test';
import { getModel } from '../../core/model-registry';
import { isModelOnDisk, ensureModelDownloaded, removeModelFiles } from '../../core/model-download';

selfTest.register('task-37e-model-download', async () => {
  const mini = getModel('paraphrase-multilingual-MiniLM-L12-v2')!;
  return [
    await scenario('download the smallest model end-to-end', async () => {
      await removeModelFiles(mini).catch(() => {});
      assertTrue(!(await isModelOnDisk(mini)), 'should start absent');
      let lastDone = 0;
      await ensureModelDownloaded(mini, (done) => { lastDone = done; });
      assertTrue(await isModelOnDisk(mini), 'should be on disk after download');
      assertTrue(lastDone > 0, 'progress callback fired');
    }),
    await scenario('removeModelFiles deletes the directory', async () => {
      await removeModelFiles(mini);
      assertTrue(!(await isModelOnDisk(mini)), 'should be gone after remove');
    }),
  ];
});
