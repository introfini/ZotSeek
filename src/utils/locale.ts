/**
 * Locale - Simple i18n for ZotSeek
 *
 * Uses a TypeScript translations map with getString(key, args?) API.
 * Detects Zotero's UI locale and falls back to en-US.
 */

declare const Zotero: any;
declare const Services: any;

type TranslationMap = Record<string, string>;

const translations: Record<string, TranslationMap> = {
  'en-US': {
    // Context menu items
    'menu.findSimilar': 'Find Similar Documents',
    'menu.openZotSeek': 'Open ZotSeek...',
    'menu.indexSelected': 'Index Selected for ZotSeek',
    'menu.indexCollection': 'Index Current Collection',
    'menu.updateLibrary': 'Update Library Index',
    'menu.removeFromIndex': 'Remove from ZotSeek Index',
    'menu.findRelated': 'Find Related Documents',

    // Toolbar
    'toolbar.openZotSeek': 'Open ZotSeek',
    'toolbar.findSimilar': 'Find Similar Documents',

    // Preference pane
    'pref.title': 'ZotSeek',
    'pref.indexStatistics': 'Index Statistics',
    'pref.papersIndexed': 'Papers Indexed',
    'pref.totalChunks': 'Total Chunks',
    'pref.storageUsed': 'Storage Used',
    'pref.model': 'Model:',
    'pref.avg': 'Avg:',
    'pref.chunksPerPaper': 'chunks/paper',
    'pref.lastIndexed': 'Last indexed:',
    'pref.refreshStats': 'Refresh Stats',
    'pref.compactDatabase': 'Compact Database',
    'pref.indexModeMismatch': 'Index Mode Mismatch',
    'pref.indexModeMismatchDesc': 'Your index was built with {indexedMode} mode, but your current setting is {currentMode}.',
    'pref.indexModeMismatchAction': 'Click "Rebuild Index" below to apply your new indexing mode setting.',
    'pref.indexingMode': 'Indexing Mode',
    'pref.abstractOnly': 'Abstract only',
    'pref.abstractOnlyMenu': 'Abstract only (faster)',
    'pref.abstractSpeed': 'Fast \u2022 ~1 chunk per paper',
    'pref.abstractDesc': 'Indexes title + abstract. Good for finding papers by topic.',
    'pref.fullPaper': 'Full paper',
    'pref.fullPaperMenu': 'Full paper (more thorough)',
    'pref.fullSpeed': 'Thorough \u2022 ~1-2 chunks per page',
    'pref.fullDesc': 'Indexes full PDF content with page numbers. Finds specific passages.',
    'pref.zotero7Note': 'Zotero 7 Note:',
    'pref.zotero7Desc': 'Full paper indexing is slower on Zotero 7 due to WASM differences. Consider using Abstract mode for large libraries.',
    'pref.autoIndexing': 'Auto-Indexing',
    'pref.autoIndexLabel': 'Automatically index new items',
    'pref.autoIndexDesc': 'New papers with PDFs are indexed in the background when added to your library.',
    'pref.delayLabel': 'Delay before indexing:',
    'pref.seconds': 'seconds',
    'pref.delayDesc': 'Wait this long after the last item is added before starting auto-indexing.',
    'pref.searchSettings': 'Search Settings',
    'pref.resultsToShow': 'Results to show',
    'pref.resultsToShowDesc': 'How many matches to display (5-100)',
    'pref.minSimilarity': 'Min similarity',
    'pref.minSimilarityDesc': '% \u2014 Filter out low-quality matches (0-100)',
    'pref.advancedSettings': 'Advanced Settings',
    'pref.maxTokens': 'Max tokens per chunk',
    'pref.maxTokensDesc': 'Chunk size ceiling (200-8000)',
    'pref.maxChunks': 'Max chunks per paper',
    'pref.maxChunksDesc': 'Limit for long documents (1-200)',
    'pref.excludeBooks': 'Exclude books from indexing',
    'pref.excludeBooksDesc': 'Books lack paper sections and are too long to index well.',
    'pref.excludeTag': 'Exclude tag',
    'pref.excludeTagDesc': 'Items with this tag will be skipped during indexing. Leave empty to disable.',
    'pref.actions': 'Actions',
    'pref.updateIndex': 'Update Index',
    'pref.recommended': '\u2713 Recommended',
    'pref.updateIndexDesc': 'Index all unindexed items in your library. Resumes safely from where you left off.',
    'pref.rebuildIndex': 'Rebuild Index',
    'pref.rebuildIndexDesc': 'Clear and re-index all items with current settings. Use after changing indexing mode.',
    'pref.clearIndex': 'Clear Index',
    'pref.destructive': '\u26A0 Destructive',
    'pref.clearIndexDesc': 'Remove all embeddings from the database. You will need to re-index afterwards.',
    'pref.about': 'About',
    'pref.githubRepo': 'GitHub Repository',
    'pref.compacted': 'Database Compacted',
    'pref.compactionFailed': 'Compaction Failed',

    // Search dialog
    'search.search': 'Search:',
    'search.placeholder': 'Enter your search query (auto-searches as you type)...',
    'search.addQuery': 'Add another query for AND/OR combination',
    'search.searchBtn': 'Search',
    'search.and': 'AND',
    'search.or': 'OR',
    'search.using': 'using',
    'search.minimum': 'Minimum',
    'search.product': 'Product',
    'search.average': 'Average',
    'search.andDesc': '\u2014 results must match both queries',
    'search.query2': 'Query 2:',
    'search.query3': 'Query 3:',
    'search.query4': 'Query 4:',
    'search.enterQuery': 'Enter query {n}...',
    'search.removeQuery': 'Remove this query',
    'search.mode': 'Mode:',
    'search.modeHybrid': '\uD83D\uDD17 Hybrid (Recommended)',
    'search.modeSemantic': '\uD83E\uDDE0 Semantic Only',
    'search.modeKeyword': '\uD83D\uDD24 Keyword Only',
    'search.modeDesc': 'Match type: \uD83D\uDD17 both searches \u00B7 \uD83E\uDDE0 AI match \u00B7 \uD83D\uDD24 keyword match',
    'search.results': 'Results:',
    'search.bySection': 'By Section',
    'search.byLocation': 'By Location (exact page & paragraph)',
    'search.settings': '\u2699 Settings',
    'search.settingsTooltip': 'Open ZotSeek preferences',
    'search.openSelected': 'Open Selected',
    'search.close': 'Close',
    'search.initializing': 'Initializing search...',
    'search.hybrid': 'Hybrid',
    'search.semantic': 'Semantic',
    'search.keyword': 'Keyword',
    'search.loadingModel': 'Loading AI model (first time may take a moment)...',
    'search.finding': '{mode} search: Finding items...',
    'search.findingMulti': '{mode} search ({op}): Finding items...',
    'search.noItemsFound': 'No items found',
    'search.showInLibrary': 'Show in Library',
    'search.showItemsInLibrary': 'Show {count} Items in Library',
    'search.addToCollection': 'Add to Collection',
    'search.noCollections': 'No collections',
    'search.moreCollections': '... and {count} more',

    // Similar documents dialog
    'similar.title': 'Find Similar Documents',
    'similar.similarTo': 'Similar to: ',
    'similar.loading': 'Loading...',
    'similar.openSelected': 'Open Selected',
    'similar.close': 'Close',
    'similar.initFailed': 'Failed to initialize: {error}',
    'similar.noSource': 'No source document selected',
    'similar.finding': 'Finding similar documents...',
    'similar.loadingModel': 'Loading AI model...',
    'similar.searching': 'Searching...',
    'similar.noResults': 'No similar documents found',
    'similar.found': 'Found {count} similar documents',
    'similar.searchFailed': 'Search failed: {error}',

    // Indexing progress
    'indexing.title': 'ZotSeek Indexing',
    'indexing.clearTitle': 'Clearing ZotSeek Index',
    'indexing.clearConfirmTitle': 'Clear ZotSeek Index',
    'indexing.clearConfirmMsg': 'This will delete all stored embeddings. You will need to re-index your library.\n\nContinue?',
    'indexing.initStorage': 'Initializing storage...',
    'indexing.deletingAll': 'Deleting all embeddings...',
    'indexing.clearedSuccess': 'Index cleared successfully!',
    'indexing.clearedMsg': 'Index cleared successfully.\n\nYou can now re-index your library.',
    'indexing.rebuildTitle': 'Rebuild ZotSeek Index',
    'indexing.rebuildConfirmTitle': 'Rebuild ZotSeek Index',
    'indexing.rebuildConfirmMsg': 'This will delete all stored embeddings and rebuild the index with your current settings.\n\nThis may take several minutes depending on library size.\n\nContinue?',
    'indexing.rebuildingTitle': 'Rebuilding ZotSeek Index',
    'indexing.clearingExisting': 'Clearing existing index...',
    'indexing.existingCleared': '\u2713 Existing index cleared',
    'indexing.loading': 'Loading...',
    'indexing.alreadyInProgress': 'Indexing already in progress...',
    'indexing.selectItems': 'Please select items to index.',
    'indexing.selectCollection': 'Please select a collection first.\n\n(Click on a collection in the left sidebar)',
    'indexing.emptyCollection': 'Collection "{name}" has no items to index.',
    'indexing.updateTitle': 'ZotSeek - Update Library Index',
    'indexing.updateConfirmMsg': 'This will index all unindexed items in your library for semantic search.\n\nItems that are already indexed will be skipped.\n\nThis may take several minutes depending on the number of new items.\n\nContinue?',
    'indexing.noItemsSelected': 'No items selected',
    'indexing.removedItems': 'Removed {count} item(s) from index',
    'indexing.notInIndex': 'Selected items were not in the index',
    'indexing.removeFailed': 'Failed to remove from index',
    'indexing.mode': 'Indexing mode: {mode}',
    'indexing.checking': 'Checking for already-indexed items...',
    'indexing.skippedExcluded': '\u2713 Skipped {count} excluded items (tag)',
    'indexing.skippedIndexed': '\u2713 Skipped {count} already-indexed items',
    'indexing.allIndexed': 'All items already indexed!',
    'indexing.allInIndex': '\u2713 {count} items already in index',
    'indexing.nothingToIndex': 'Nothing to index \u2014 all items are up to date!',
    'indexing.loadingModel': 'Loading AI model (Transformers.js)...',
    'indexing.modelLoaded': '\u2713 AI model loaded',
    'indexing.batchExtracting': 'Batch {current}/{total}: Extracting text...',
    'indexing.batchEmbedding': 'Batch {current}/{total}: Generating embeddings...',
    'indexing.batchEmbeddingChunks': 'Batch {current}/{total}: Embedding chunks',
    'indexing.chunksFailed': '\u26A0 {count} chunks skipped in: {items}',
    'indexing.batchSaving': 'Batch {current}/{total}: Saving checkpoint...',
    'indexing.checkpoint': '\u2713 Checkpoint {current}/{total}: {items} items, {chunks} chunks saved',
    'indexing.complete': 'Indexing Complete!',
    'indexing.completeMode': '\u2713 Mode: {mode}',
    'indexing.completePrevious': '\u2713 Previously indexed: {count} items',
    'indexing.completeNew': '\u2713 Newly indexed: {count} items',
    'indexing.completeChunks': '\u2713 Total chunks: {count}',
    'indexing.completeAvg': '\u2713 Avg chunks/item: {avg}',
    'indexing.completeDuration': '\u2713 Duration: {duration}',
    'indexing.completeNoContent': '\u26A0 No content: {count} items',
    'indexing.completeSuccess': 'Indexing completed successfully!',
    'indexing.cancelled': 'Indexing cancelled',
    'indexing.failed': 'Indexing failed: {error}',
    'indexing.progressTitle': 'ZotSeek',
    'indexing.progressItem': 'Indexing: {title}',
    'indexing.progressLoadingModel': 'Loading model...',
    'indexing.allExcluded': 'All items excluded by tag',
    'indexing.extracting': 'Extracting...',
    'indexing.noContent': '\u2717 No content found',
    'indexing.embedding': 'Embedding {current}/{total}...',
    'indexing.saving': 'Saving...',
    'indexing.chunksIndexed': '\u2713 {count} chunks indexed',
    'indexing.chunksIndexedWithFailed': '\u2713 {count} chunks indexed ({failed} failed)',
  },

  'zh-CN': {
    // Context menu items
    'menu.findSimilar': '\u67E5\u627E\u76F8\u4F3C\u6587\u732E',
    'menu.openZotSeek': '\u6253\u5F00 ZotSeek...',
    'menu.indexSelected': '\u4E3A ZotSeek \u7D22\u5F15\u9009\u4E2D\u9879',
    'menu.indexCollection': '\u7D22\u5F15\u5F53\u524D\u5408\u96C6',
    'menu.updateLibrary': '\u66F4\u65B0\u6587\u732E\u5E93\u7D22\u5F15',
    'menu.removeFromIndex': '\u4ECE ZotSeek \u7D22\u5F15\u4E2D\u79FB\u9664',
    'menu.findRelated': '\u67E5\u627E\u76F8\u5173\u6587\u732E',

    // Toolbar
    'toolbar.openZotSeek': '\u6253\u5F00 ZotSeek',
    'toolbar.findSimilar': '\u67E5\u627E\u76F8\u4F3C\u6587\u732E',

    // Preference pane
    'pref.title': 'ZotSeek',
    'pref.indexStatistics': '\u7D22\u5F15\u7EDF\u8BA1',
    'pref.papersIndexed': '\u5DF2\u7D22\u5F15\u6587\u732E',
    'pref.totalChunks': '\u603B\u5206\u5757\u6570',
    'pref.storageUsed': '\u5B58\u50A8\u5360\u7528',
    'pref.model': '\u6A21\u578B\uFF1A',
    'pref.avg': '\u5E73\u5747\uFF1A',
    'pref.chunksPerPaper': '\u5206\u5757/\u6587\u732E',
    'pref.lastIndexed': '\u4E0A\u6B21\u7D22\u5F15\uFF1A',
    'pref.refreshStats': '\u5237\u65B0\u7EDF\u8BA1',
    'pref.compactDatabase': '\u538B\u7F29\u6570\u636E\u5E93',
    'pref.indexModeMismatch': '\u7D22\u5F15\u6A21\u5F0F\u4E0D\u5339\u914D',
    'pref.indexModeMismatchDesc': '\u60A8\u7684\u7D22\u5F15\u662F\u4F7F\u7528{indexedMode}\u6A21\u5F0F\u6784\u5EFA\u7684\uFF0C\u4F46\u5F53\u524D\u8BBE\u7F6E\u4E3A{currentMode}\u3002',
    'pref.indexModeMismatchAction': '\u70B9\u51FB\u4E0B\u65B9\u201C\u91CD\u5EFA\u7D22\u5F15\u201D\u4EE5\u5E94\u7528\u65B0\u7684\u7D22\u5F15\u6A21\u5F0F\u8BBE\u7F6E\u3002',
    'pref.indexingMode': '\u7D22\u5F15\u6A21\u5F0F',
    'pref.abstractOnly': '\u4EC5\u6458\u8981',
    'pref.abstractOnlyMenu': '\u4EC5\u6458\u8981\uFF08\u66F4\u5FEB\uFF09',
    'pref.abstractSpeed': '\u5FEB\u901F \u2022 \u6BCF\u7BC7\u6587\u732E\u7EA61\u4E2A\u5206\u5757',
    'pref.abstractDesc': '\u7D22\u5F15\u6807\u9898\u548C\u6458\u8981\u3002\u9002\u5408\u6309\u4E3B\u9898\u67E5\u627E\u6587\u732E\u3002',
    'pref.fullPaper': '\u5168\u6587',
    'pref.fullPaperMenu': '\u5168\u6587\uFF08\u66F4\u5F7B\u5E95\uFF09',
    'pref.fullSpeed': '\u5F7B\u5E95 \u2022 \u6BCF\u98751-2\u4E2A\u5206\u5757',
    'pref.fullDesc': '\u7D22\u5F15\u5B8C\u6574PDF\u5185\u5BB9\u53CA\u9875\u7801\u3002\u53EF\u67E5\u627E\u7279\u5B9A\u6BB5\u843D\u3002',
    'pref.zotero7Note': 'Zotero 7 \u6CE8\u610F\uFF1A',
    'pref.zotero7Desc': '\u7531\u4E8EWASM\u5DEE\u5F02\uFF0CZotero 7\u4E0A\u7684\u5168\u6587\u7D22\u5F15\u8F83\u6162\u3002\u5EFA\u8BAE\u5927\u578B\u6587\u732E\u5E93\u4F7F\u7528\u6458\u8981\u6A21\u5F0F\u3002',
    'pref.autoIndexing': '\u81EA\u52A8\u7D22\u5F15',
    'pref.autoIndexLabel': '\u81EA\u52A8\u7D22\u5F15\u65B0\u6761\u76EE',
    'pref.autoIndexDesc': '\u6DFB\u52A0\u5230\u6587\u732E\u5E93\u7684\u65B0\u6587\u732E\u5C06\u5728\u540E\u53F0\u81EA\u52A8\u7D22\u5F15\u3002',
    'pref.delayLabel': '\u7D22\u5F15\u524D\u5EF6\u8FDF\uFF1A',
    'pref.seconds': '\u79D2',
    'pref.delayDesc': '\u6DFB\u52A0\u6700\u540E\u4E00\u4E2A\u6761\u76EE\u540E\u7B49\u5F85\u8FD9\u4E48\u957F\u65F6\u95F4\u518D\u5F00\u59CB\u81EA\u52A8\u7D22\u5F15\u3002',
    'pref.searchSettings': '\u641C\u7D22\u8BBE\u7F6E',
    'pref.resultsToShow': '\u663E\u793A\u7ED3\u679C\u6570',
    'pref.resultsToShowDesc': '\u663E\u793A\u591A\u5C11\u4E2A\u5339\u914D\u7ED3\u679C\uFF085-100\uFF09',
    'pref.minSimilarity': '\u6700\u4F4E\u76F8\u4F3C\u5EA6',
    'pref.minSimilarityDesc': '% \u2014 \u8FC7\u6EE4\u4F4E\u8D28\u91CF\u5339\u914D\uFF080-100\uFF09',
    'pref.advancedSettings': '\u9AD8\u7EA7\u8BBE\u7F6E',
    'pref.maxTokens': '\u6BCF\u5206\u5757\u6700\u5927\u4EE4\u724C\u6570',
    'pref.maxTokensDesc': '\u5206\u5757\u5927\u5C0F\u4E0A\u9650\uFF08200-8000\uFF09',
    'pref.maxChunks': '\u6BCF\u7BC7\u6587\u732E\u6700\u5927\u5206\u5757\u6570',
    'pref.maxChunksDesc': '\u957F\u6587\u6863\u9650\u5236\uFF081-200\uFF09',
    'pref.excludeBooks': '\u6392\u9664\u4E66\u7C4D',
    'pref.excludeBooksDesc': '\u4E66\u7C4D\u7F3A\u4E4F\u8BBA\u6587\u7ED3\u6784\u4E14\u592A\u957F\uFF0C\u4E0D\u9002\u5408\u7D22\u5F15\u3002',
    'pref.excludeTag': '\u6392\u9664\u6807\u7B7E',
    'pref.excludeTagDesc': '\u5E26\u6709\u6B64\u6807\u7B7E\u7684\u6761\u76EE\u5C06\u5728\u7D22\u5F15\u65F6\u88AB\u8DF3\u8FC7\u3002\u7559\u7A7A\u4EE5\u7981\u7528\u3002',
    'pref.actions': '\u64CD\u4F5C',
    'pref.updateIndex': '\u66F4\u65B0\u7D22\u5F15',
    'pref.recommended': '\u2713 \u63A8\u8350',
    'pref.updateIndexDesc': '\u7D22\u5F15\u6587\u732E\u5E93\u4E2D\u6240\u6709\u672A\u7D22\u5F15\u7684\u6761\u76EE\u3002\u53EF\u4ECE\u4E0A\u6B21\u4E2D\u65AD\u5904\u5B89\u5168\u6062\u590D\u3002',
    'pref.rebuildIndex': '\u91CD\u5EFA\u7D22\u5F15',
    'pref.rebuildIndexDesc': '\u6E05\u9664\u5E76\u4F7F\u7528\u5F53\u524D\u8BBE\u7F6E\u91CD\u65B0\u7D22\u5F15\u6240\u6709\u6761\u76EE\u3002\u66F4\u6539\u7D22\u5F15\u6A21\u5F0F\u540E\u4F7F\u7528\u3002',
    'pref.clearIndex': '\u6E05\u9664\u7D22\u5F15',
    'pref.destructive': '\u26A0 \u6709\u7834\u574F\u6027',
    'pref.clearIndexDesc': '\u4ECE\u6570\u636E\u5E93\u4E2D\u5220\u9664\u6240\u6709\u5D4C\u5165\u5411\u91CF\u3002\u4E4B\u540E\u9700\u8981\u91CD\u65B0\u7D22\u5F15\u3002',
    'pref.about': '\u5173\u4E8E',
    'pref.githubRepo': 'GitHub \u4ED3\u5E93',
    'pref.compacted': '\u6570\u636E\u5E93\u5DF2\u538B\u7F29',
    'pref.compactionFailed': '\u538B\u7F29\u5931\u8D25',

    // Search dialog
    'search.search': '\u641C\u7D22\uFF1A',
    'search.placeholder': '\u8F93\u5165\u641C\u7D22\u67E5\u8BE2\uFF08\u8F93\u5165\u65F6\u81EA\u52A8\u641C\u7D22\uFF09...',
    'search.addQuery': '\u6DFB\u52A0\u67E5\u8BE2\u4EE5\u8FDB\u884CAND/OR\u7EC4\u5408',
    'search.searchBtn': '\u641C\u7D22',
    'search.and': 'AND',
    'search.or': 'OR',
    'search.using': '\u4F7F\u7528',
    'search.minimum': '\u6700\u5C0F\u503C',
    'search.product': '\u4E58\u79EF',
    'search.average': '\u5E73\u5747\u503C',
    'search.andDesc': '\u2014 \u7ED3\u679C\u5FC5\u987B\u5339\u914D\u4E24\u4E2A\u67E5\u8BE2',
    'search.query2': '\u67E5\u8BE2 2\uFF1A',
    'search.query3': '\u67E5\u8BE2 3\uFF1A',
    'search.query4': '\u67E5\u8BE2 4\uFF1A',
    'search.enterQuery': '\u8F93\u5165\u67E5\u8BE2 {n}...',
    'search.removeQuery': '\u5220\u9664\u6B64\u67E5\u8BE2',
    'search.mode': '\u6A21\u5F0F\uFF1A',
    'search.modeHybrid': '\uD83D\uDD17 \u6DF7\u5408\uFF08\u63A8\u8350\uFF09',
    'search.modeSemantic': '\uD83E\uDDE0 \u4EC5\u8BED\u4E49',
    'search.modeKeyword': '\uD83D\uDD24 \u4EC5\u5173\u952E\u8BCD',
    'search.modeDesc': '\u5339\u914D\u7C7B\u578B\uFF1A\uD83D\uDD17 \u4E24\u79CD\u641C\u7D22 \u00B7 \uD83E\uDDE0 AI\u5339\u914D \u00B7 \uD83D\uDD24 \u5173\u952E\u8BCD\u5339\u914D',
    'search.results': '\u7ED3\u679C\uFF1A',
    'search.bySection': '\u6309\u7AE0\u8282',
    'search.byLocation': '\u6309\u4F4D\u7F6E\uFF08\u7CBE\u786E\u9875\u7801\u548C\u6BB5\u843D\uFF09',
    'search.settings': '\u2699 \u8BBE\u7F6E',
    'search.settingsTooltip': '\u6253\u5F00 ZotSeek \u8BBE\u7F6E',
    'search.openSelected': '\u6253\u5F00\u9009\u4E2D\u9879',
    'search.close': '\u5173\u95ED',
    'search.initializing': '\u6B63\u5728\u521D\u59CB\u5316\u641C\u7D22...',
    'search.hybrid': '\u6DF7\u5408',
    'search.semantic': '\u8BED\u4E49',
    'search.keyword': '\u5173\u952E\u8BCD',
    'search.loadingModel': '\u6B63\u5728\u52A0\u8F7DAI\u6A21\u578B\uFF08\u9996\u6B21\u53EF\u80FD\u9700\u8981\u7A0D\u7B49\uFF09...',
    'search.finding': '{mode}\u641C\u7D22\uFF1A\u6B63\u5728\u67E5\u627E...',
    'search.findingMulti': '{mode}\u641C\u7D22\uFF08{op}\uFF09\uFF1A\u6B63\u5728\u67E5\u627E...',
    'search.noItemsFound': '\u672A\u627E\u5230\u6761\u76EE',
    'search.showInLibrary': '\u5728\u6587\u732E\u5E93\u4E2D\u663E\u793A',
    'search.showItemsInLibrary': '\u5728\u6587\u732E\u5E93\u4E2D\u663E\u793A {count} \u4E2A\u6761\u76EE',
    'search.addToCollection': '\u6DFB\u52A0\u5230\u5408\u96C6',
    'search.noCollections': '\u65E0\u5408\u96C6',
    'search.moreCollections': '... \u53CA\u5176\u4ED6 {count} \u4E2A',

    // Similar documents dialog
    'similar.title': '\u67E5\u627E\u76F8\u4F3C\u6587\u732E',
    'similar.similarTo': '\u76F8\u4F3C\u4E8E\uFF1A',
    'similar.loading': '\u52A0\u8F7D\u4E2D...',
    'similar.openSelected': '\u6253\u5F00\u9009\u4E2D\u9879',
    'similar.close': '\u5173\u95ED',
    'similar.initFailed': '\u521D\u59CB\u5316\u5931\u8D25\uFF1A{error}',
    'similar.noSource': '\u672A\u9009\u62E9\u6E90\u6587\u732E',
    'similar.finding': '\u6B63\u5728\u67E5\u627E\u76F8\u4F3C\u6587\u732E...',
    'similar.loadingModel': '\u6B63\u5728\u52A0\u8F7DAI\u6A21\u578B...',
    'similar.searching': '\u641C\u7D22\u4E2D...',
    'similar.noResults': '\u672A\u627E\u5230\u76F8\u4F3C\u6587\u732E',
    'similar.found': '\u627E\u5230 {count} \u7BC7\u76F8\u4F3C\u6587\u732E',
    'similar.searchFailed': '\u641C\u7D22\u5931\u8D25\uFF1A{error}',

    // Indexing progress
    'indexing.title': 'ZotSeek \u7D22\u5F15',
    'indexing.clearTitle': '\u6B63\u5728\u6E05\u9664 ZotSeek \u7D22\u5F15',
    'indexing.clearConfirmTitle': '\u6E05\u9664 ZotSeek \u7D22\u5F15',
    'indexing.clearConfirmMsg': '\u8FD9\u5C06\u5220\u9664\u6240\u6709\u5B58\u50A8\u7684\u5D4C\u5165\u5411\u91CF\u3002\u60A8\u9700\u8981\u91CD\u65B0\u7D22\u5F15\u6587\u732E\u5E93\u3002\n\n\u7EE7\u7EED\uFF1F',
    'indexing.initStorage': '\u6B63\u5728\u521D\u59CB\u5316\u5B58\u50A8...',
    'indexing.deletingAll': '\u6B63\u5728\u5220\u9664\u6240\u6709\u5D4C\u5165\u5411\u91CF...',
    'indexing.clearedSuccess': '\u7D22\u5F15\u5DF2\u6210\u529F\u6E05\u9664\uFF01',
    'indexing.clearedMsg': '\u7D22\u5F15\u5DF2\u6210\u529F\u6E05\u9664\u3002\n\n\u60A8\u73B0\u5728\u53EF\u4EE5\u91CD\u65B0\u7D22\u5F15\u6587\u732E\u5E93\u3002',
    'indexing.rebuildTitle': '\u91CD\u5EFA ZotSeek \u7D22\u5F15',
    'indexing.rebuildConfirmTitle': '\u91CD\u5EFA ZotSeek \u7D22\u5F15',
    'indexing.rebuildConfirmMsg': '\u8FD9\u5C06\u5220\u9664\u6240\u6709\u5B58\u50A8\u7684\u5D4C\u5165\u5411\u91CF\u5E76\u4F7F\u7528\u5F53\u524D\u8BBE\u7F6E\u91CD\u5EFA\u7D22\u5F15\u3002\n\n\u6839\u636E\u6587\u732E\u5E93\u5927\u5C0F\uFF0C\u8FD9\u53EF\u80FD\u9700\u8981\u51E0\u5206\u949F\u3002\n\n\u7EE7\u7EED\uFF1F',
    'indexing.rebuildingTitle': '\u6B63\u5728\u91CD\u5EFA ZotSeek \u7D22\u5F15',
    'indexing.clearingExisting': '\u6B63\u5728\u6E05\u9664\u73B0\u6709\u7D22\u5F15...',
    'indexing.existingCleared': '\u2713 \u73B0\u6709\u7D22\u5F15\u5DF2\u6E05\u9664',
    'indexing.loading': '\u52A0\u8F7D\u4E2D...',
    'indexing.alreadyInProgress': '\u7D22\u5F15\u5DF2\u5728\u8FDB\u884C\u4E2D...',
    'indexing.selectItems': '\u8BF7\u9009\u62E9\u8981\u7D22\u5F15\u7684\u6761\u76EE\u3002',
    'indexing.selectCollection': '\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u5408\u96C6\u3002\n\n\uFF08\u5728\u5DE6\u4FA7\u8FB9\u680F\u4E2D\u70B9\u51FB\u4E00\u4E2A\u5408\u96C6\uFF09',
    'indexing.emptyCollection': '\u5408\u96C6\u201C{name}\u201D\u6CA1\u6709\u53EF\u7D22\u5F15\u7684\u6761\u76EE\u3002',
    'indexing.updateTitle': 'ZotSeek - \u66F4\u65B0\u6587\u732E\u5E93\u7D22\u5F15',
    'indexing.updateConfirmMsg': '\u8FD9\u5C06\u4E3A\u6587\u732E\u5E93\u4E2D\u6240\u6709\u672A\u7D22\u5F15\u7684\u6761\u76EE\u5EFA\u7ACB\u8BED\u4E49\u641C\u7D22\u7D22\u5F15\u3002\n\n\u5DF2\u7D22\u5F15\u7684\u6761\u76EE\u5C06\u88AB\u8DF3\u8FC7\u3002\n\n\u6839\u636E\u65B0\u6761\u76EE\u6570\u91CF\uFF0C\u8FD9\u53EF\u80FD\u9700\u8981\u51E0\u5206\u949F\u3002\n\n\u7EE7\u7EED\uFF1F',
    'indexing.noItemsSelected': '\u672A\u9009\u62E9\u6761\u76EE',
    'indexing.removedItems': '\u5DF2\u4ECE\u7D22\u5F15\u4E2D\u79FB\u9664 {count} \u4E2A\u6761\u76EE',
    'indexing.notInIndex': '\u9009\u4E2D\u7684\u6761\u76EE\u4E0D\u5728\u7D22\u5F15\u4E2D',
    'indexing.removeFailed': '\u4ECE\u7D22\u5F15\u4E2D\u79FB\u9664\u5931\u8D25',
    'indexing.mode': '\u7D22\u5F15\u6A21\u5F0F\uFF1A{mode}',
    'indexing.checking': '\u6B63\u5728\u68C0\u67E5\u5DF2\u7D22\u5F15\u7684\u6761\u76EE...',
    'indexing.skippedExcluded': '\u2713 \u8DF3\u8FC7 {count} \u4E2A\u5DF2\u6392\u9664\u6761\u76EE\uFF08\u6807\u7B7E\uFF09',
    'indexing.skippedIndexed': '\u2713 \u8DF3\u8FC7 {count} \u4E2A\u5DF2\u7D22\u5F15\u6761\u76EE',
    'indexing.allIndexed': '\u6240\u6709\u6761\u76EE\u5DF2\u7D22\u5F15\uFF01',
    'indexing.allInIndex': '\u2713 {count} \u4E2A\u6761\u76EE\u5DF2\u5728\u7D22\u5F15\u4E2D',
    'indexing.nothingToIndex': '\u65E0\u9700\u7D22\u5F15 \u2014 \u6240\u6709\u6761\u76EE\u5747\u5DF2\u662F\u6700\u65B0\uFF01',
    'indexing.loadingModel': '\u6B63\u5728\u52A0\u8F7DAI\u6A21\u578B\uFF08Transformers.js\uFF09...',
    'indexing.modelLoaded': '\u2713 AI\u6A21\u578B\u5DF2\u52A0\u8F7D',
    'indexing.batchExtracting': '\u6279\u6B21 {current}/{total}\uFF1A\u6B63\u5728\u63D0\u53D6\u6587\u672C...',
    'indexing.batchEmbedding': '\u6279\u6B21 {current}/{total}\uFF1A\u6B63\u5728\u751F\u6210\u5D4C\u5165\u5411\u91CF...',
    'indexing.batchEmbeddingChunks': '\u6279\u6B21 {current}/{total}\uFF1A\u5D4C\u5165\u5206\u5757',
    'indexing.chunksFailed': '\u26A0 {count} \u4E2A\u5206\u5757\u5DF2\u8DF3\u8FC7\uFF1A{items}',
    'indexing.batchSaving': '\u6279\u6B21 {current}/{total}\uFF1A\u6B63\u5728\u4FDD\u5B58\u68C0\u67E5\u70B9...',
    'indexing.checkpoint': '\u2713 \u68C0\u67E5\u70B9 {current}/{total}\uFF1A{items} \u4E2A\u6761\u76EE\uFF0C{chunks} \u4E2A\u5206\u5757\u5DF2\u4FDD\u5B58',
    'indexing.complete': '\u7D22\u5F15\u5B8C\u6210\uFF01',
    'indexing.completeMode': '\u2713 \u6A21\u5F0F\uFF1A{mode}',
    'indexing.completePrevious': '\u2713 \u5148\u524D\u5DF2\u7D22\u5F15\uFF1A{count} \u4E2A\u6761\u76EE',
    'indexing.completeNew': '\u2713 \u65B0\u7D22\u5F15\uFF1A{count} \u4E2A\u6761\u76EE',
    'indexing.completeChunks': '\u2713 \u603B\u5206\u5757\u6570\uFF1A{count}',
    'indexing.completeAvg': '\u2713 \u5E73\u5747\u5206\u5757/\u6761\u76EE\uFF1A{avg}',
    'indexing.completeDuration': '\u2713 \u65F6\u957F\uFF1A{duration}',
    'indexing.completeNoContent': '\u26A0 \u65E0\u5185\u5BB9\uFF1A{count} \u4E2A\u6761\u76EE',
    'indexing.completeSuccess': '\u7D22\u5F15\u5DF2\u6210\u529F\u5B8C\u6210\uFF01',
    'indexing.cancelled': '\u7D22\u5F15\u5DF2\u53D6\u6D88',
    'indexing.failed': '\u7D22\u5F15\u5931\u8D25\uFF1A{error}',
    'indexing.progressTitle': 'ZotSeek',
    'indexing.progressItem': '\u6B63\u5728\u7D22\u5F15\uFF1A{title}',
    'indexing.progressLoadingModel': '\u6B63\u5728\u52A0\u8F7D\u6A21\u578B...',
    'indexing.allExcluded': '\u6240\u6709\u6761\u76EE\u5747\u5DF2\u6309\u6807\u7B7E\u6392\u9664',
    'indexing.extracting': '\u6B63\u5728\u63D0\u53D6...',
    'indexing.noContent': '\u2717 \u672A\u627E\u5230\u5185\u5BB9',
    'indexing.embedding': '\u5D4C\u5165 {current}/{total}...',
    'indexing.saving': '\u6B63\u5728\u4FDD\u5B58...',
    'indexing.chunksIndexed': '\u2713 {count} \u4E2A\u5206\u5757\u5DF2\u7D22\u5F15',
    'indexing.chunksIndexedWithFailed': '\u2713 {count} \u4E2A\u5206\u5757\u5DF2\u7D22\u5F15\uFF08{failed} \u4E2A\u5931\u8D25\uFF09',
  },
};

/**
 * Get the current Zotero UI locale (e.g., 'en-US', 'zh-CN')
 */
function getLocale(): string {
  try {
    // Zotero 8+
    if (typeof Services !== 'undefined' && Services.locale?.appLocaleAsBCP47) {
      return Services.locale.appLocaleAsBCP47;
    }
    // Fallback
    if (typeof Zotero !== 'undefined' && Zotero.locale) {
      return Zotero.locale;
    }
  } catch (e) {
    // ignore
  }
  return 'en-US';
}

/**
 * Get a localized string by key, with optional argument substitution.
 *
 * @param key - The string key (e.g., 'menu.findSimilar')
 * @param args - Optional substitution map (e.g., { count: 5 })
 * @returns The localized string, or the key itself if not found
 *
 * @example
 * getString('menu.findSimilar')           // "Find Similar Documents"
 * getString('indexing.found', { count: 5 }) // "Found 5 similar documents"
 */
/**
 * Translate all elements with data-l10n-key attribute in the given document.
 * For elements with a `label` attribute (XUL buttons, checkboxes), sets the label.
 * For elements with a `value` attribute (XUL labels), sets the value.
 * For other elements, sets textContent.
 * Also handles data-l10n-attr to set specific attributes (e.g., placeholder, tooltiptext).
 */
export function translateDOM(doc: Document): void {
  const elements = Array.from(doc.querySelectorAll('[data-l10n-key]'));
  for (const el of elements) {
    const key = el.getAttribute('data-l10n-key');
    if (!key) continue;

    const translated = getString(key);
    if (translated === key) continue; // no translation found

    const attr = el.getAttribute('data-l10n-attr');
    if (attr) {
      el.setAttribute(attr, translated);
    } else if (el.hasAttribute('label')) {
      el.setAttribute('label', translated);
    } else if (el.hasAttribute('value') && el.tagName === 'label') {
      el.setAttribute('value', translated);
    } else {
      el.textContent = translated;
    }
  }
}

export function getString(key: string, args?: Record<string, string | number>): string {
  const locale = getLocale();

  // Try exact locale match, then language prefix, then en-US fallback
  const langPrefix = locale.split('-')[0];
  const map = translations[locale]
    || Object.keys(translations).find(k => k.startsWith(langPrefix)) && translations[Object.keys(translations).find(k => k.startsWith(langPrefix))!]
    || translations['en-US'];

  let str = map[key] || translations['en-US'][key] || key;

  // Substitute {argName} placeholders
  if (args) {
    for (const [name, value] of Object.entries(args)) {
      str = str.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    }
  }

  return str;
}
