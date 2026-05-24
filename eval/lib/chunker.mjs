const SECTION_PATTERNS = {
  methods: /\n(?=(?:\d+\.?\s*)?(?:Introduction|Background|Literature\s*Review|Related\s*Work|Theoretical\s*Framework|Methods?|Methodology|Materials?\s*(?:and\s*Methods)?|Experimental\s*(?:Setup|Design)?|Study\s*Design|Data\s*(?:Collection|Sources)|Approach|Framework|Model|System|Implementation)\b)/i,
  findings: /\n(?=(?:\d+\.?\s*)?(?:Results?|Findings|Evaluation|Experiments?|Analysis|Discussion|Implications|Conclusion|Conclusions|Summary|Limitations|Future\s*Work|Recommendations)\b)/i,
};

export function estimateTokens(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(w => w.length > 0);
  return Math.ceil(words.length * 1.3);
}

function splitTextIntoChunks(text, titlePrefix, maxTokens, type) {
  const chunks = [];
  const titleTokens = estimateTokens(titlePrefix) + 10;
  const availableTokens = maxTokens - titleTokens;

  if (estimateTokens(text) <= availableTokens) {
    chunks.push({
      index: 0,
      text: `${titlePrefix}\n\n${text}`,
      type,
      tokenCount: estimateTokens(text) + titleTokens,
    });
    return chunks;
  }

  const paragraphSplits = text.split(/\n\n+/);
  const paragraphs = paragraphSplits.filter(p => p.trim().length > 50);

  let currentChunk = '';
  let currentTokens = 0;

  const flush = () => {
    if (currentChunk.trim()) {
      chunks.push({
        index: chunks.length,
        text: `${titlePrefix}\n\n${currentChunk.trim()}`,
        type,
        tokenCount: currentTokens + titleTokens,
      });
    }
  };

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (paraTokens > availableTokens) {
      flush();
      currentChunk = '';
      currentTokens = 0;
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      for (const sentence of sentences) {
        const sentTokens = estimateTokens(sentence);
        if (currentTokens + sentTokens > availableTokens && currentChunk.trim()) {
          flush();
          currentChunk = sentence;
          currentTokens = sentTokens;
        } else {
          currentChunk += sentence;
          currentTokens += sentTokens;
        }
      }
    } else if (currentTokens + paraTokens > availableTokens) {
      flush();
      currentChunk = para + '\n\n';
      currentTokens = paraTokens;
    } else {
      currentChunk += para + '\n\n';
      currentTokens += paraTokens;
    }
  }

  flush();
  return chunks;
}

function splitIntoSemanticSections(fulltext) {
  const findingsMatch = SECTION_PATTERNS.findings.exec(fulltext);
  if (findingsMatch && findingsMatch.index > 500) {
    const methodsText = fulltext.substring(0, findingsMatch.index).trim();
    const findingsText = fulltext.substring(findingsMatch.index).trim();
    return {
      methods: methodsText.length > 300 ? methodsText : null,
      findings: findingsText.length > 300 ? findingsText : null,
    };
  }
  return { methods: null, findings: null };
}

function isReferencesHeader(text) {
  const firstLine = text.split('\n')[0].trim().toLowerCase();
  return /^(references?|bibliography|works?\s*cited|literature\s*cited|citations?)$/i.test(firstLine) ||
         /^\d+\.?\s*(references?|bibliography)$/i.test(firstLine);
}

function isReferenceEntry(text) {
  const patterns = [
    /^\[\d+\]/,
    /^\d+\.\s+[A-Z]/,
    /^[A-Z][a-z]+,\s*[A-Z]\.\s*[A-Z]?\.\s*\(/,
    /\(\d{4}[a-z]?\)\./,
    /doi:\s*10\./i,
    /https?:\/\/doi\.org/i,
    /pp\.\s*\d+[-–]\d+/,
    /Vol\.\s*\d+/i,
  ];
  return patterns.some(p => p.test(text));
}

function stripReferences(fulltext) {
  const paragraphs = fulltext.split(/\n\n+/);
  const kept = [];
  for (const para of paragraphs) {
    if (isReferencesHeader(para)) break;
    if (isReferenceEntry(para)) continue;
    kept.push(para);
  }
  return kept.join('\n\n');
}

function enforceCharLimit(chunks, maxChars, maxChunks) {
  const result = [];
  for (const chunk of chunks) {
    if (result.length >= maxChunks) break;
    if (chunk.text.length <= maxChars) {
      result.push(chunk);
    } else {
      const separatorIdx = chunk.text.indexOf('\n\n');
      const titlePrefix = separatorIdx >= 0 ? chunk.text.substring(0, separatorIdx) : '';
      const body = separatorIdx >= 0 ? chunk.text.substring(separatorIdx + 2) : chunk.text;
      const prefixLen = titlePrefix.length + 2;
      const availableChars = maxChars - prefixLen;
      if (availableChars <= 0) {
        result.push({ ...chunk, text: chunk.text.substring(0, maxChars) });
        continue;
      }
      const sentences = body.match(/[^.!?]+[.!?]+/g) || [body];
      let currentText = '';
      for (const sentence of sentences) {
        if (result.length >= maxChunks) break;
        const capped = sentence.length > availableChars
          ? sentence.substring(0, availableChars) : sentence;
        if (currentText.length + capped.length > availableChars && currentText.trim()) {
          result.push({
            ...chunk,
            index: result.length,
            text: titlePrefix ? `${titlePrefix}\n\n${currentText.trim()}` : currentText.trim(),
          });
          currentText = capped;
        } else {
          currentText += capped;
        }
      }
      if (currentText.trim() && result.length < maxChunks) {
        result.push({
          ...chunk,
          index: result.length,
          text: titlePrefix ? `${titlePrefix}\n\n${currentText.trim()}` : currentText.trim(),
        });
      }
    }
  }
  return result;
}

export function chunkDocument(title, abstract_text, fulltext, maxTokens, maxChunks = 200, maxChars = 8000) {
  const chunks = [];
  let wasTruncated = false;

  const titlePrefix = title.length > 300 ? title.substring(0, 300) + '...' : title;

  const summaryText = abstract_text && abstract_text.length > 50
    ? `${titlePrefix}\n\n${abstract_text}`
    : titlePrefix;
  chunks.push({ index: 0, text: summaryText, type: 'summary', tokenCount: estimateTokens(summaryText) });

  if (!fulltext || fulltext.length < 500) {
    return { chunks: enforceCharLimit(chunks, maxChars, maxChunks), wasTruncated };
  }

  const cleanedText = stripReferences(fulltext);
  if (cleanedText.length < 500) {
    return { chunks: enforceCharLimit(chunks, maxChars, maxChunks), wasTruncated };
  }

  const sections = splitIntoSemanticSections(cleanedText);

  const addChunks = (sectionChunks) => {
    for (const c of sectionChunks) {
      if (chunks.length >= maxChunks) { wasTruncated = true; break; }
      chunks.push({ ...c, index: chunks.length });
    }
  };

  if (sections.methods || sections.findings) {
    if (sections.methods) {
      addChunks(splitTextIntoChunks(sections.methods, titlePrefix, maxTokens, 'methods'));
    }
    if (sections.findings) {
      addChunks(splitTextIntoChunks(sections.findings, titlePrefix, maxTokens, 'findings'));
    }
  } else {
    addChunks(splitTextIntoChunks(cleanedText, titlePrefix, maxTokens, 'content'));
  }

  return { chunks: enforceCharLimit(chunks, maxChars, maxChunks), wasTruncated };
}
