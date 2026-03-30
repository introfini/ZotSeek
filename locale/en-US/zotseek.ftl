# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Context menu items

zotseek-menu-findSimilar = Find Similar Documents
zotseek-menu-openZotSeek = Open ZotSeek...
zotseek-menu-indexSelected = Index Selected for ZotSeek
zotseek-menu-indexCollection = Index Current Collection
zotseek-menu-updateLibrary = Update Library Index
zotseek-menu-removeFromIndex = Remove from ZotSeek Index
zotseek-menu-findRelated = Find Related Documents

## Toolbar

zotseek-toolbar-openZotSeek = Open ZotSeek
zotseek-toolbar-findSimilar = Find Similar Documents

## Preference pane

zotseek-pref-title = ZotSeek
zotseek-pref-indexStatistics = Index Statistics
zotseek-pref-papersIndexed = Papers Indexed
zotseek-pref-totalChunks = Total Chunks
zotseek-pref-storageUsed = Storage Used
zotseek-pref-model = Model:
zotseek-pref-avg = Avg:
zotseek-pref-chunksPerPaper = chunks/paper
zotseek-pref-lastIndexed = Last indexed:
zotseek-pref-refreshStats =
    .label = Refresh Stats
zotseek-pref-compactDatabase =
    .label = Compact Database
zotseek-pref-indexModeMismatch = Index Mode Mismatch
zotseek-pref-indexModeMismatchDesc = Your index was built with { $indexedMode } mode, but your current setting is { $currentMode }.
zotseek-pref-indexModeMismatchAction = Click "Rebuild Index" below to apply your new indexing mode setting.
zotseek-pref-indexingMode = Indexing Mode
zotseek-pref-abstractOnly = Abstract only
zotseek-pref-abstractOnlyMenu =
    .label = Abstract only (faster)
zotseek-pref-abstractSpeed = Fast • ~1 chunk per paper
zotseek-pref-abstractDesc = Indexes title + abstract. Good for finding papers by topic.
zotseek-pref-fullPaper = Full paper
zotseek-pref-fullPaperMenu =
    .label = Full paper (more thorough)
zotseek-pref-fullSpeed = Thorough • ~1-2 chunks per page
zotseek-pref-fullDesc = Indexes full PDF content with page numbers. Finds specific passages.
zotseek-pref-zotero7Note = Zotero 7 Note:
zotseek-pref-zotero7Desc = Full paper indexing is slower on Zotero 7 due to WASM differences. Consider using Abstract mode for large libraries.
zotseek-pref-autoIndexing = Auto-Indexing
zotseek-pref-autoIndexLabel =
    .label = Automatically index new items
zotseek-pref-autoIndexDesc = New papers with PDFs are indexed in the background when added to your library.
zotseek-pref-delayLabel = Delay before indexing:
zotseek-pref-seconds = seconds
zotseek-pref-delayDesc = Wait this long after the last item is added before starting auto-indexing.
zotseek-pref-searchSettings = Search Settings
zotseek-pref-resultsToShow = Results to show
zotseek-pref-resultsToShowDesc = How many matches to display (5-100)
zotseek-pref-minSimilarity = Min similarity
zotseek-pref-minSimilarityDesc = % — Filter out low-quality matches (0-100)
zotseek-pref-advancedSettings = Advanced Settings
zotseek-pref-maxTokens = Max tokens per chunk
zotseek-pref-maxTokensDesc = Chunk size ceiling (200-8000)
zotseek-pref-maxChunks = Max chunks per paper
zotseek-pref-maxChunksDesc = Limit for long documents (1-200)
zotseek-pref-excludeBooks =
    .label = Exclude books from indexing
zotseek-pref-excludeBooksDesc = Books lack paper sections and are too long to index well.
zotseek-pref-excludeTag = Exclude tag
zotseek-pref-excludeTagDesc = Items with this tag will be skipped during indexing. Leave empty to disable.
zotseek-pref-actions = Actions
zotseek-pref-updateIndex =
    .label = Update Index
zotseek-pref-recommended = ✓ Recommended
zotseek-pref-updateIndexDesc = Index all unindexed items in your library. Resumes safely from where you left off.
zotseek-pref-rebuildIndex =
    .label = Rebuild Index
zotseek-pref-rebuildIndexDesc = Clear and re-index all items with current settings. Use after changing indexing mode.
zotseek-pref-clearIndex =
    .label = Clear Index
zotseek-pref-destructive = ⚠ Destructive
zotseek-pref-clearIndexDesc = Remove all embeddings from the database. You will need to re-index afterwards.
zotseek-pref-about = About
zotseek-pref-githubRepo =
    .value = GitHub Repository
zotseek-pref-modelLine = Model: { $model }
zotseek-pref-avgLine = Avg: { $avg } chunks/paper
zotseek-pref-lastIndexedLine = Last indexed: { $date }
zotseek-pref-compacted = Database Compacted
zotseek-pref-compactionFailed = Compaction Failed

## Search dialog

zotseek-search-search =
    .value = Search:
zotseek-search-placeholder =
    .placeholder = Enter your search query (auto-searches as you type)...
zotseek-search-addQuery =
    .label = +
    .tooltiptext = Add another query for AND/OR combination
zotseek-search-searchBtn =
    .label = Search
zotseek-search-and =
    .label = AND
zotseek-search-or =
    .label = OR
zotseek-search-using =
    .value = using
zotseek-search-minimum =
    .label = Minimum
zotseek-search-product =
    .label = Product
zotseek-search-average =
    .label = Average
zotseek-search-andDesc =
    .value = — results must match both queries
zotseek-search-query2 =
    .value = Query 2:
zotseek-search-query3 =
    .value = Query 3:
zotseek-search-query4 =
    .value = Query 4:
zotseek-search-enterQuery = Enter query { $n }...
zotseek-search-removeQuery =
    .label = ✕
    .tooltiptext = Remove this query
zotseek-search-mode =
    .value = Mode:
zotseek-search-modeHybrid =
    .label = 🔗 Hybrid (Recommended)
zotseek-search-modeSemantic =
    .label = 🧠 Semantic Only
zotseek-search-modeKeyword =
    .label = 🔤 Keyword Only
zotseek-search-modeDesc =
    .value = Match type: 🔗 both searches · 🧠 AI match · 🔤 keyword match
zotseek-search-results =
    .value = Results:
zotseek-search-bySection = By Section
zotseek-search-byLocation = By Location (exact page & paragraph)
zotseek-search-settings =
    .label = ⚙ Settings
    .tooltiptext = Open ZotSeek preferences
zotseek-search-openSelected =
    .label = Open Selected
zotseek-search-close =
    .label = Close
zotseek-search-initializing = Initializing search...
zotseek-search-hybrid = Hybrid
zotseek-search-semantic = Semantic
zotseek-search-keyword = Keyword
zotseek-search-loadingModel = Loading AI model (first time may take a moment)...
zotseek-search-finding = { $mode } search: Finding items...
zotseek-search-findingMulti = { $mode } search ({ $op }): Finding items...
zotseek-search-noItemsFound = No items found
zotseek-search-showInLibrary = Show in Library
zotseek-search-showItemsInLibrary = Show { $count } Items in Library
zotseek-search-addToCollection = Add to Collection
zotseek-search-noCollections = No collections
zotseek-search-moreCollections = ... and { $count } more
zotseek-search-foundItems = Found { $count } items
zotseek-search-foundItemsFromMatches = Found { $count } items (from { $matches } matches)
zotseek-search-foundItemsQuery = Found { $count } items ({ $query })
zotseek-search-searching = Searching...
zotseek-search-searchLabel = Search
zotseek-search-searchingMoment = Searching in a moment...
zotseek-search-failed = Search failed: { $error }
zotseek-search-noItemsMatchingAll = No items found matching all queries
zotseek-search-matchBoth = — results must match both queries
zotseek-search-matchAll = — results must match all queries
zotseek-search-matchAny = — results can match any query

## Results table columns

zotseek-column-match = Match
zotseek-column-title = Title
zotseek-column-authors = Authors
zotseek-column-year = Year
zotseek-column-location = Location
zotseek-column-section = Section

## Source labels

zotseek-source-abstract = Abstract
zotseek-source-fulltext = Full Text
zotseek-source-title = Title
zotseek-source-methods = Methods
zotseek-source-results = Results
zotseek-source-content = Content
zotseek-search-hybrid-menuitem =
    .label = 🔗 Hybrid (Recommended)
zotseek-search-semantic-menuitem =
    .label = 🧠 Semantic Only
zotseek-search-keyword-menuitem =
    .label = 🔤 Keyword Only

## Similar documents dialog

zotseek-similar-title =
    .title = Find Similar Documents
zotseek-similar-similarTo = Similar to:{ " " }
zotseek-similar-loading = Loading...
zotseek-similar-openSelected =
    .label = Open Selected
zotseek-similar-close =
    .label = Close
zotseek-similar-initFailed = Failed to initialize: { $error }
zotseek-similar-noSource = No source document selected
zotseek-similar-finding = Finding similar documents...
zotseek-similar-loadingModel = Loading AI model...
zotseek-similar-searching = Searching...
zotseek-similar-noResults = No similar documents found
zotseek-similar-found = Found { $count } similar documents
zotseek-similar-searchFailed = Search failed: { $error }

## Indexing progress

zotseek-indexing-title = ZotSeek Indexing
zotseek-indexing-clearTitle = Clearing ZotSeek Index
zotseek-indexing-clearConfirmTitle = Clear ZotSeek Index
zotseek-indexing-clearConfirmMsg = This will delete all stored embeddings. You will need to re-index your library.

    Continue?
zotseek-indexing-initStorage = Initializing storage...
zotseek-indexing-deletingAll = Deleting all embeddings...
zotseek-indexing-clearedSuccess = Index cleared successfully!
zotseek-indexing-clearedMsg = Index cleared successfully.

    You can now re-index your library.
zotseek-indexing-rebuildTitle = Rebuild ZotSeek Index
zotseek-indexing-rebuildConfirmTitle = Rebuild ZotSeek Index
zotseek-indexing-rebuildConfirmMsg = This will delete all stored embeddings and rebuild the index with your current settings.

    This may take several minutes depending on library size.

    Continue?
zotseek-indexing-rebuildingTitle = Rebuilding ZotSeek Index
zotseek-indexing-clearingExisting = Clearing existing index...
zotseek-indexing-existingCleared = ✓ Existing index cleared
zotseek-indexing-loading = Loading...
zotseek-indexing-alreadyInProgress = Indexing already in progress...
zotseek-indexing-selectItems = Please select items to index.
zotseek-indexing-selectCollection = Please select a collection first.

    (Click on a collection in the left sidebar)
zotseek-indexing-emptyCollection = Collection "{ $name }" has no items to index.
zotseek-indexing-updateTitle = ZotSeek - Update Library Index
zotseek-indexing-updateConfirmMsg = This will index all unindexed items in your library for semantic search.

    Items that are already indexed will be skipped.

    This may take several minutes depending on the number of new items.

    Continue?
zotseek-indexing-noItemsSelected = No items selected
zotseek-indexing-removedItems = Removed { $count } item(s) from index
zotseek-indexing-notInIndex = Selected items were not in the index
zotseek-indexing-removeFailed = Failed to remove from index
zotseek-indexing-mode = Indexing mode: { $mode }
zotseek-indexing-checking = Checking for already-indexed items...
zotseek-indexing-skippedExcluded = ✓ Skipped { $count } excluded items (tag)
zotseek-indexing-skippedIndexed = ✓ Skipped { $count } already-indexed items
zotseek-indexing-allIndexed = All items already indexed!
zotseek-indexing-allInIndex = ✓ { $count } items already in index
zotseek-indexing-nothingToIndex = Nothing to index — all items are up to date!
zotseek-indexing-loadingModel = Loading AI model (Transformers.js)...
zotseek-indexing-modelLoaded = ✓ AI model loaded
zotseek-indexing-batchExtracting = Batch { $current }/{ $total }: Extracting text...
zotseek-indexing-batchEmbedding = Batch { $current }/{ $total }: Generating embeddings...
zotseek-indexing-batchEmbeddingChunks = Batch { $current }/{ $total }: Embedding chunks
zotseek-indexing-chunksFailed = ⚠ { $count } chunks skipped in: { $items }
zotseek-indexing-batchSaving = Batch { $current }/{ $total }: Saving checkpoint...
zotseek-indexing-checkpoint = ✓ Checkpoint { $current }/{ $total }: { $items } items, { $chunks } chunks saved
zotseek-indexing-complete = Indexing Complete!
zotseek-indexing-completeMode = ✓ Mode: { $mode }
zotseek-indexing-completePrevious = ✓ Previously indexed: { $count } items
zotseek-indexing-completeNew = ✓ Newly indexed: { $count } items
zotseek-indexing-completeChunks = ✓ Total chunks: { $count }
zotseek-indexing-completeAvg = ✓ Avg chunks/item: { $avg }
zotseek-indexing-completeDuration = ✓ Duration: { $duration }
zotseek-indexing-completeNoContent = ⚠ No content: { $count } items
zotseek-indexing-completeSuccess = Indexing completed successfully!
zotseek-indexing-cancelled = Indexing cancelled
zotseek-indexing-failed = Indexing failed: { $error }
zotseek-indexing-progressTitle = ZotSeek
zotseek-indexing-progressItem = Indexing: { $title }
zotseek-indexing-progressLoadingModel = Loading model...
zotseek-indexing-allExcluded = All items excluded by tag
zotseek-indexing-extracting = Extracting...
zotseek-indexing-noContent = ✗ No content found
zotseek-indexing-embedding = Embedding { $current }/{ $total }...
zotseek-indexing-saving = Saving...
zotseek-indexing-chunksIndexed = ✓ { $count } chunks indexed
zotseek-indexing-chunksIndexedWithFailed = ✓ { $count } chunks indexed ({ $failed } failed)
