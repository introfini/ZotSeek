import { selfTest, scenario, assertTrue, assertEq } from '../self-test';
import { getModel } from '../../core/model-registry';
import { isModelOnDisk, ensureModelDownloaded, removeModelFiles } from '../../core/model-download';
import { embeddingPipeline } from '../../core/embedding-pipeline';

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
    await scenario('load the downloaded model via resource:// and embed', async () => {
      // Switch the pipeline to the downloaded model; the worker loads it from
      // resource://zotseek-models/. A successful embed of the right dimension
      // proves the download + resource substitution + worker load chain works.
      try {
        await embeddingPipeline.setModel('paraphrase-multilingual-MiniLM-L12-v2');
        const r = await embeddingPipeline.embedQuery('a test sentence');
        assertEq(r.embedding.length, 384, 'MiniLM should produce 384-dim vectors');
        assertEq(r.modelId, 'paraphrase-multilingual-MiniLM-L12-v2', 'modelId should be the short id');
      } finally {
        // Always restore the default model so the rest of the session is unaffected.
        await embeddingPipeline.setModel('nomic-embed-text-v1.5');
      }
    }),
    await scenario('removeModelFiles deletes the directory', async () => {
      await removeModelFiles(mini);
      assertTrue(!(await isModelOnDisk(mini)), 'should be gone after remove');
    }),
  ];
});
