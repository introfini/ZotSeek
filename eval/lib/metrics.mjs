export function reciprocalRank(ranked, relevant) {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export function recallAtK(ranked, relevant, k) {
  if (relevant.size === 0) return 0;
  const topK = new Set(ranked.slice(0, k));
  let found = 0;
  for (const r of relevant) {
    if (topK.has(r)) found++;
  }
  return found / relevant.size;
}

export function ndcgAtK(ranked, relevant, k) {
  if (relevant.size === 0) return 0;

  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  let idcg = 0;
  const idealCount = Math.min(relevant.size, k);
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export function computeMetrics(ranked, relevant) {
  return {
    mrr: reciprocalRank(ranked, relevant),
    'recall@5': recallAtK(ranked, relevant, 5),
    'recall@10': recallAtK(ranked, relevant, 10),
    'recall@20': recallAtK(ranked, relevant, 20),
    'ndcg@10': ndcgAtK(ranked, relevant, 10),
  };
}

export function aggregateMetrics(allMetrics) {
  const keys = Object.keys(allMetrics[0]);
  const result = {};
  for (const key of keys) {
    const values = allMetrics.map(m => m[key]);
    result[key] = values.reduce((a, b) => a + b, 0) / values.length;
  }
  return result;
}
