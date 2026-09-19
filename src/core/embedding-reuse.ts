/**
 * Re-indexing an item used to re-embed every one of its chunks. That is
 * acceptable when indexing is triggered by a new paper arriving, and wasteful
 * once it is triggered by editing a note: one changed line would pay for the
 * whole paper, on the CPU-only machines this feature was asked for.
 *
 * Reuse is keyed by chunk text rather than chunk position, so inserting,
 * deleting or reordering chunks does not invalidate the ones that did not
 * change. The stored embedding model is bundled with its data, so if a model
 * switch occurs, every chunk goes to `toEmbed` (clean miss) rather than
 * silently reusing vectors from the wrong space.
 */

export interface ReuseCandidate {
  /** Embedding-map key, `${itemId}_${chunkIndex}` as built by the indexing paths. */
  id: string;
  itemId: number;
  text: string;
}

export interface StoredEmbeddings {
  /** The model ID these embeddings were built with. */
  modelId: string;
  /** Embeddings keyed by item id, then by chunk text. */
  byItem: Map<number, Map<string, number[]>>;
}

export interface ReuseResult {
  toEmbed: ReuseCandidate[];
  reused: Map<string, { embedding: number[]; modelId: string }>;
}

export function splitReusable(
  chunks: ReuseCandidate[],
  stored: StoredEmbeddings,
  modelId: string
): ReuseResult {
  const toEmbed: ReuseCandidate[] = [];
  const reused = new Map<string, { embedding: number[]; modelId: string }>();

  // If the stored embeddings are from a different model, all chunks must be
  // embedded. This produces a clean miss rather than silently using vectors
  // from the wrong space.
  if (stored.modelId !== modelId) {
    return { toEmbed: chunks, reused };
  }

  for (const chunk of chunks) {
    const embedding = stored.byItem.get(chunk.itemId)?.get(chunk.text);
    if (embedding) {
      reused.set(chunk.id, { embedding, modelId });
    } else {
      toEmbed.push(chunk);
    }
  }

  return { toEmbed, reused };
}
